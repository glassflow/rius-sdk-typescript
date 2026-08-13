import { SpanStatusCode } from "@opentelemetry/api";
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { Mask } from "./config.js";
import {
  CONTENT_ATTRIBUTES,
  CONTENT_ATTRIBUTE_PREFIXES,
  CONTENT_ATTRIBUTE_SUFFIXES,
} from "./semconv.js";
import { toAttributeValue } from "./serde.js";

export function isContentKey(key: string): boolean {
  if (CONTENT_ATTRIBUTES.has(key)) return true;
  if (CONTENT_ATTRIBUTE_PREFIXES.some((p) => key.startsWith(p))) return true;
  return CONTENT_ATTRIBUTE_SUFFIXES.some((s) => key.endsWith(s));
}

/** OTel's name for the event `recordException` adds. */
const EXCEPTION_EVENT_NAME = "exception";

/**
 * The exception-event attributes that can carry user content. A provider error
 * routinely echoes the offending request back in its message, and a stacktrace
 * can carry it in a frame argument, so both are stripped under
 * `captureContent: false`. `exception.type` is a class name, never content, and
 * survives together with the event itself so a failure is still visible.
 */
const EXCEPTION_CONTENT_KEYS: readonly string[] = ["exception.message", "exception.stacktrace"];

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
      if (event.name !== EXCEPTION_EVENT_NAME) continue;
      for (const key of EXCEPTION_CONTENT_KEYS) delete attributes[key];
    }

    for (const link of span.links ?? []) {
      this.sanitizeAttributes(link.attributes as Record<string, unknown> | undefined);
    }

    if (!this.opts.captureContent && span.status?.code === SpanStatusCode.ERROR) {
      // `recordException` copies the thrown error's message onto the status,
      // which is the same leak the exception event's `exception.message` is
      // stripped for above. `status` is mutable and exposed by reference on
      // the SDK span, same as `attributes`, so mutating it in place here
      // reaches the span that is about to be handed to the inner exporter.
      // The ERROR code itself is left alone so the failure stays visible.
      span.status.message = undefined;
    }

    return span;
  }

  /** Strips or masks the content keys of one attribute bag, in place. */
  private sanitizeAttributes(attributes: Record<string, unknown> | undefined): void {
    if (attributes === undefined) return;
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
