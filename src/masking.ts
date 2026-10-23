import { SpanStatusCode } from "@opentelemetry/api";
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { Mask } from "./config.js";
import { isNativeSpan } from "./nativeProviderSpans.js";
import {
  CONTENT_ATTRIBUTE_PREFIXED_SUFFIXES,
  CONTENT_ATTRIBUTE_PREFIXES,
  CONTENT_ATTRIBUTE_SUFFIXES,
  CONTENT_ATTRIBUTES,
  CONTENT_PREFIX_IDENTITY_ATTRIBUTES,
  EXCEPTION_EVENT,
  EXCEPTION_MESSAGE,
  EXCEPTION_STACKTRACE,
  URL_FULL,
  URL_QUERY,
} from "./semconv.js";
import { toAttributeValue, truncate } from "./serde.js";

/** The namespace the OpenInference Vercel transform mirrors unknown attributes into. */
const METADATA_PREFIX = "metadata.";

export function isContentKey(key: string): boolean {
  if (CONTENT_ATTRIBUTES.has(key)) return true;
  if (
    CONTENT_ATTRIBUTE_PREFIXES.some((p) => key.startsWith(p)) &&
    !CONTENT_PREFIX_IDENTITY_ATTRIBUTES.has(key)
  )
    return true;
  if (CONTENT_ATTRIBUTE_SUFFIXES.some((s) => key.endsWith(s))) return true;
  if (
    CONTENT_ATTRIBUTE_PREFIXED_SUFFIXES.some(
      ([prefix, leaves]) => key.startsWith(prefix) && leaves.some((leaf) => key.endsWith(leaf)),
    )
  )
    return true;
  // The SDK no longer runs @arizeai/openinference-vercel, but an app can run
  // its span processor itself on a provider the SDK bridges onto
  // (bridgeForeignProvider). That processor rewrites every span's attributes
  // in place at onEnd and copies the ones it does not translate under
  // `metadata.<original key>`, so a content key comes through twice. Masking
  // runs at export, after it, and the mirrored copy is content exactly when
  // the original is: otherwise metadata.gen_ai.system_instructions carries
  // the system prompt past captureContent: false.
  return key.startsWith(METADATA_PREFIX) && isContentKey(key.slice(METADATA_PREFIX.length));
}

/**
 * The exception-event attributes that can carry user content. A provider error
 * routinely echoes the offending request back in its message, and a stacktrace
 * can carry it in a frame argument, so both are stripped under
 * `captureContent: false` and run through the mask otherwise.
 * `exception.type` is a class name, never content, and survives together with
 * the event itself so a failure is still visible.
 */
const EXCEPTION_CONTENT_KEYS: readonly string[] = [EXCEPTION_MESSAGE, EXCEPTION_STACKTRACE];

/**
 * The URL attributes that are content on the Anthropic SDK's own spans only.
 * In its content mode the SDK keeps the query parameters it treats as content
 * (an `email` or `path_prefix` filter, and more that differ by endpoint) in
 * `url.query` and `url.full`; outside it, it leaves both off when the query
 * has one. Rius cannot tell which parameters an endpoint treats as content,
 * so the whole query is content there. On every other span they are an HTTP
 * call's URL, so they are not content keys.
 */
const ANTHROPIC_SDK_URL_CONTENT_KEYS: readonly string[] = [URL_QUERY, URL_FULL];

/**
 * What is left of a content attribute with content capture off, or
 * `undefined` to drop it: `url.full` keeps its scheme, host and path, since
 * only its query and fragment are content. Every other key is dropped.
 */
function withoutContent(key: string, value: unknown): unknown {
  if (key === URL_FULL && typeof value === "string") return value.split(/[?#]/, 1)[0];
  return undefined;
}

/**
 * The status description is the same string once more: `recordException`
 * copies the error's message onto the status, and providers echo the rejected
 * request. Not an attribute, so it gets its own pass; this is the `key` a
 * mask sees for it (same name the Python SDK uses).
 */
const STATUS_DESCRIPTION_KEY = "status.description";

/** The warning for a mask that threw on `key`, whose value is then dropped. */
function maskWarning(key: string, error: unknown): void {
  console.warn(`[rius] mask threw for ${key}; value dropped.`, error);
}

/**
 * What a mask returned, as the attribute value to write, or `undefined` to
 * drop the attribute: the Python SDK's `_safe_value`. `null` / `undefined`
 * mean "drop", a string, number or boolean is kept as it is (a string still
 * bounded), and anything else is written as its JSON.
 */
function maskedValue(value: unknown): string | number | boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  return toAttributeValue(value);
}

/**
 * Strips or masks content attributes before spans leave the process. Covers our
 * own spans and any bundled third-party instrumentation, which is why the key
 * sets live in semconv rather than here.
 *
 * Span attributes are not the only carrier: the GenAI semantic conventions also
 * describe an event-based shape for messages, and links can carry attributes
 * too, so events and links are sanitised on the same rules.
 *
 * Never throws into the export pipeline.
 */
export class MaskingSpanExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly opts: { captureContent: boolean; mask?: Mask },
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.inner.export(
      spans.map((s) => this.sanitized(s)),
      resultCallback,
    );
  }

  private sanitized(span: ReadableSpan): ReadableSpan {
    this.sanitizeAttributes(
      span.attributes as Record<string, unknown> | undefined,
      isNativeSpan(span) ? ANTHROPIC_SDK_URL_CONTENT_KEYS : undefined,
    );

    for (const event of span.events ?? []) {
      // On an exception event the message and stacktrace are content too, so
      // they are stripped or masked by the same rule as every content key.
      const extra = event.name === EXCEPTION_EVENT ? EXCEPTION_CONTENT_KEYS : undefined;
      this.sanitizeAttributes(event.attributes as Record<string, unknown> | undefined, extra);
    }

    for (const link of span.links ?? []) {
      this.sanitizeAttributes(link.attributes as Record<string, unknown> | undefined);
    }

    this.sanitizeStatus(span);
    return span;
  }

  /**
   * Drops or masks the status description, in place. `status` is mutable and
   * exposed by reference on the SDK span, same as `attributes`, so mutating it
   * here reaches the span about to be handed to the inner exporter. The ERROR
   * code itself is left alone so the failure stays visible and classifiable,
   * the same policy as `exception.type`.
   */
  private sanitizeStatus(span: ReadableSpan): void {
    const status = span.status;
    if (status?.code !== SpanStatusCode.ERROR || !status.message) return;
    if (!this.opts.captureContent) {
      status.message = undefined;
      return;
    }
    if (this.opts.mask === undefined) return;
    // Fail closed, as for an attribute: a mask that throws or returns
    // nothing drops the description, never leaks it.
    let masked: string | number | boolean | undefined;
    try {
      masked = maskedValue(this.opts.mask(status.message, { key: STATUS_DESCRIPTION_KEY }));
    } catch (error) {
      maskWarning(STATUS_DESCRIPTION_KEY, error);
    }
    status.message = masked === undefined ? undefined : String(masked);
  }

  /** Strips or masks the content keys of one attribute bag, in place. */
  private sanitizeAttributes(
    attributes: Record<string, unknown> | undefined,
    extraContentKeys: readonly string[] = [],
  ): void {
    if (attributes === undefined) return;
    for (const key of Object.keys(attributes)) {
      if (!isContentKey(key) && !extraContentKeys.includes(key)) continue;
      if (!this.opts.captureContent) {
        const kept = withoutContent(key, attributes[key]);
        if (kept === undefined) delete attributes[key];
        else attributes[key] = kept;
        continue;
      }
      if (this.opts.mask === undefined) continue;
      // Fail closed: a mask that throws or returns nothing drops the
      // attribute, so it neither leaks the unmasked value nor stops the batch.
      let masked: string | number | boolean | undefined;
      try {
        masked = maskedValue(this.opts.mask(attributes[key], { key }));
      } catch (error) {
        maskWarning(key, error);
      }
      if (masked === undefined) delete attributes[key];
      else attributes[key] = masked;
    }
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
