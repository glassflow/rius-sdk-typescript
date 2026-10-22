import { type Context, diag } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { errorType } from "./errorType.js";

/**
 * Span processors can only be given to a provider at construction, but some
 * are added after it (the heartbeat's open-root tracker, for one). This
 * processor is registered up front and forwards to a list that can grow
 * later.
 *
 * Spans that already ENDED before a delegate is added are not replayed to it.
 */
export class DelegatingSpanProcessor implements SpanProcessor {
  private readonly delegates: SpanProcessor[] = [];

  add(processor: SpanProcessor): void {
    this.delegates.push(processor);
  }

  /**
   * Insert ahead of existing delegates, for a processor that must observe a
   * span before the pipeline's own processors do: normalization rewrites the
   * attributes in place, so only a processor added first sees them raw.
   */
  addFirst(processor: SpanProcessor): void {
    this.delegates.unshift(processor);
  }

  /** Delegates that already threw, so each is reported once, not once per span. */
  private readonly warned = new WeakSet<SpanProcessor>();

  // Each delegate isolated: these run inside the caller's `startSpan()` and
  // `span.end()`, so one throwing processor must neither throw into the app
  // nor skip the delegates after it (the batch processor that exports).
  onStart(span: Span, parentContext: Context): void {
    for (const delegate of this.delegates) {
      try {
        delegate.onStart(span, parentContext);
      } catch (error) {
        this.report(delegate, "onStart", error);
      }
    }
  }

  onEnd(span: ReadableSpan): void {
    for (const delegate of this.delegates) {
      try {
        delegate.onEnd(span);
      } catch (error) {
        this.report(delegate, "onEnd", error);
      }
    }
  }

  private report(delegate: SpanProcessor, hook: string, error: unknown): void {
    if (this.warned.has(delegate)) return;
    this.warned.add(delegate);
    const name = delegate.constructor?.name || "anonymous";
    console.warn(
      `[rius] span processor ${name} threw in ${hook} (${errorType(error)}); the span continues through the rest of the pipeline. Further errors from this processor are not reported.`,
    );
    // The warning names only the error type; the full error (message, stack)
    // is for whoever turns on OTel diagnostics to debug the processor.
    diag.debug(`rius: span processor ${name} threw in ${hook}`, error);
  }

  async forceFlush(): Promise<void> {
    // allSettled, not all: third-party processors are added here, and one
    // rejecting delegate must not reject the user's flush() or leave the other
    // delegates unflushed. The async wrapper turns a delegate that throws
    // synchronously into a rejection allSettled can absorb, instead of an
    // exception that escapes map() before allSettled ever runs.
    await Promise.allSettled(this.delegates.map(async (d) => d.forceFlush()));
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.delegates.map(async (d) => d.shutdown()));
  }
}
