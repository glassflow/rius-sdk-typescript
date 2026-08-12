import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * Span processors can only be given to a provider at construction, but the
 * auto-instrumentation registry resolves asynchronously and may contribute one
 * afterwards. This processor is registered up front and forwards to a list that
 * can grow later.
 *
 * Spans that already ENDED before a delegate is added are not replayed to it.
 */
export class DelegatingSpanProcessor implements SpanProcessor {
  private readonly delegates: SpanProcessor[] = [];

  add(processor: SpanProcessor): void {
    this.delegates.push(processor);
  }

  onStart(span: Span, parentContext: Context): void {
    for (const delegate of this.delegates) delegate.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    for (const delegate of this.delegates) delegate.onEnd(span);
  }

  async forceFlush(): Promise<void> {
    // allSettled, not all: third-party processors are added here, and one
    // rejecting delegate must not reject the user's flush() or leave the other
    // delegates unflushed.
    await Promise.allSettled(this.delegates.map((d) => d.forceFlush()));
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.delegates.map((d) => d.shutdown()));
  }
}
