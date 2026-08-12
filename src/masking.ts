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

/**
 * Strips or masks content attributes before spans leave the process. Covers our
 * own spans and any bundled third-party instrumentation, which is why the key
 * sets live in semconv rather than here.
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
    const attributes = span.attributes as Record<string, unknown>;
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
    return span;
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
