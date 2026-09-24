import { SpanStatusCode } from "@opentelemetry/api";
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { Mask } from "./config.js";
import {
  CONTENT_ATTRIBUTES,
  CONTENT_ATTRIBUTE_PREFIXES,
  CONTENT_ATTRIBUTE_SUFFIXES,
  EXCEPTION_EVENT,
  INVOCATION_PARAMETERS_CONTENT_MEMBERS,
  LLM_INVOCATION_PARAMETERS,
} from "./semconv.js";
import { toAttributeValue } from "./serde.js";

/** The namespace the OpenInference Vercel transform mirrors unknown attributes into. */
const METADATA_PREFIX = "metadata.";

export function isContentKey(key: string): boolean {
  if (CONTENT_ATTRIBUTES.has(key)) return true;
  if (CONTENT_ATTRIBUTE_PREFIXES.some((p) => key.startsWith(p))) return true;
  if (CONTENT_ATTRIBUTE_SUFFIXES.some((s) => key.endsWith(s))) return true;
  // The Vercel transform copies attributes it does not translate under
  // `metadata.<original key>`, so a content key comes through twice; the
  // mirrored copy is content exactly when the original is. Found by the
  // sentinel test: metadata.gen_ai.system_instructions carried the system
  // prompt past captureContent: false.
  return key.startsWith(METADATA_PREFIX) && isContentKey(key.slice(METADATA_PREFIX.length));
}

/**
 * The tools/functions members removed, the rest kept; `undefined` = drop the
 * whole attribute.
 *
 * `llm.invocation_parameters` is not wholly content — sampling parameters are
 * identity — but the litellm and langchain instrumentations embed the
 * request's tool definitions inside it. Whenever sanitization runs (content
 * capture off, or a mask installed), those members must not leave the process.
 * An unparseable payload is dropped whole: it might hide tool definitions, and
 * unreadable is exactly when a pass-through is wrong.
 */
function redactInvocationParameters(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let parameters: unknown;
  try {
    parameters = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) {
    return undefined;
  }
  const bag = parameters as Record<string, unknown>;
  if (!INVOCATION_PARAMETERS_CONTENT_MEMBERS.some((member) => member in bag)) {
    return value; // nothing sensitive; keep byte-identical
  }
  for (const member of INVOCATION_PARAMETERS_CONTENT_MEMBERS) delete bag[member];
  return JSON.stringify(bag);
}

/**
 * The exception-event attributes that can carry user content. A provider error
 * routinely echoes the offending request back in its message, and a stacktrace
 * can carry it in a frame argument, so both are stripped under
 * `captureContent: false`. `exception.type` is a class name, never content, and
 * survives together with the event itself so a failure is still visible.
 */
const EXCEPTION_CONTENT_KEYS: readonly string[] = ["exception.message", "exception.stacktrace"];

/**
 * The status description is the same string once more: `recordException`
 * copies the error's message onto the status, and providers echo the rejected
 * request. Not an attribute, so it gets its own pass; this is the `key` a
 * mask sees for it (same name the Python SDK uses).
 */
const STATUS_DESCRIPTION_KEY = "status.description";

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
    this.sanitizeAttributes(span.attributes as Record<string, unknown> | undefined);

    for (const event of span.events ?? []) {
      const attributes = event.attributes as Record<string, unknown> | undefined;
      this.sanitizeAttributes(attributes);
      if (this.opts.captureContent || attributes === undefined) continue;
      if (event.name !== EXCEPTION_EVENT) continue;
      for (const key of EXCEPTION_CONTENT_KEYS) delete attributes[key];
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
    try {
      const masked = toAttributeValue(
        this.opts.mask(status.message, { key: STATUS_DESCRIPTION_KEY }),
      );
      status.message = typeof masked === "string" ? masked : String(masked);
    } catch {
      status.message = "[mask error]";
    }
  }

  /** Strips or masks the content keys of one attribute bag, in place. */
  private sanitizeAttributes(attributes: Record<string, unknown> | undefined): void {
    if (attributes === undefined) return;
    const sanitizing = !this.opts.captureContent || this.opts.mask !== undefined;
    if (sanitizing && LLM_INVOCATION_PARAMETERS in attributes) {
      // Partial redaction, not the strip/mask below: the key mixes identity
      // (sampling params) with content (embedded tool definitions).
      const redacted = redactInvocationParameters(attributes[LLM_INVOCATION_PARAMETERS]);
      if (redacted === undefined) delete attributes[LLM_INVOCATION_PARAMETERS];
      else attributes[LLM_INVOCATION_PARAMETERS] = redacted;
    }
    for (const key of Object.keys(attributes)) {
      if (!isContentKey(key)) continue;
      if (!this.opts.captureContent) {
        delete attributes[key];
        continue;
      }
      if (this.opts.mask === undefined) continue;
      try {
        attributes[key] = toAttributeValue(this.opts.mask(attributes[key], { key }));
      } catch {
        attributes[key] = "[mask error]";
      }
    }
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
