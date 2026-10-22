import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { type RiusClient, spanProcessorSink } from "../src/client.js";

/**
 * Put `processor` ahead of the client's own pipeline, so a test sees each span
 * before normalization and the exporting processor do. The SDK itself never
 * needs this order, so it is a test seam reaching into the sink rather than a
 * method on it.
 */
export function prependProcessor(client: RiusClient, processor: SpanProcessor): void {
  (spanProcessorSink(client) as unknown as { delegates: SpanProcessor[] }).delegates.unshift(
    processor,
  );
}
