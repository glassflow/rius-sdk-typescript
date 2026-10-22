import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  CREDENTIAL_HEADER_NAME_SUFFIXES,
  CREDENTIAL_HEADER_NAMES,
  HEADER_ATTRIBUTE_SEGMENTS,
} from "./semconv.js";

/**
 * True when `key` holds a credential header: a key segment from
 * HEADER_ATTRIBUTE_SEGMENTS (`ai.request.headers.<name>`,
 * `http.request.header.<name>`), followed by a name in CREDENTIAL_HEADER_NAMES
 * or ending in one of CREDENTIAL_HEADER_NAME_SUFFIXES. Compared lower-cased,
 * with "_" read as "-": the AI SDK keeps the caller's spelling on some
 * operations, and OpenTelemetry Python's HTTP instrumentations write
 * `x_api_key`. The name is what follows the segment's last occurrence.
 */
export function isCredentialHeaderKey(key: string): boolean {
  const lowered = key.toLowerCase();
  for (const segment of HEADER_ATTRIBUTE_SEGMENTS) {
    const at = lowered.lastIndexOf(segment);
    if (at < 0) continue;
    const name = lowered.slice(at + segment.length).replaceAll("_", "-");
    if (CREDENTIAL_HEADER_NAMES.includes(name)) return true;
    if (CREDENTIAL_HEADER_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  }
  return false;
}

/**
 * Drops credential headers from every span before it leaves the process,
 * whatever `captureContent` and `mask` say. A credential is not content: a
 * mask may be absent or pass it through, and content capture is on by
 * default. Installed unconditionally, in the exporter chain both final spans
 * and pending snapshots go through. Attributes, event attributes and link
 * attributes alike, mutated in place as MaskingSpanExporter does.
 */
export class CredentialHeaderDroppingExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    for (const span of spans) {
      dropCredentialHeaders(span.attributes as Record<string, unknown> | undefined);
      for (const event of span.events ?? []) {
        dropCredentialHeaders(event.attributes as Record<string, unknown> | undefined);
      }
      for (const link of span.links ?? []) {
        dropCredentialHeaders(link.attributes as Record<string, unknown> | undefined);
      }
    }
    this.inner.export(spans, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

function dropCredentialHeaders(attributes: Record<string, unknown> | undefined): void {
  if (attributes === undefined) return;
  for (const key of Object.keys(attributes)) {
    if (isCredentialHeaderKey(key)) delete attributes[key];
  }
}
