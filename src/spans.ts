import { type Span, SpanStatusCode } from "@opentelemetry/api";
import { getTracer } from "./client.js";
import { INPUT_VALUE, OUTPUT_VALUE, SpanKind, kindAttributes } from "./semconv.js";
import { toAttributeValue } from "./serde.js";

export interface SpanOptions {
  kind?: SpanKind;
  input?: unknown;
}

/** A handle over a span. Chainable setters; `end()` is idempotent. */
export class Observation {
  protected ended = false;

  constructor(readonly span: Span) {}

  setInput(value: unknown): this {
    this.span.setAttribute(INPUT_VALUE, toAttributeValue(value));
    return this;
  }

  setOutput(value: unknown): this {
    this.span.setAttribute(OUTPUT_VALUE, toAttributeValue(value));
    return this;
  }

  setAttribute(key: string, value: unknown): this {
    this.span.setAttribute(key, toAttributeValue(value));
    return this;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.span.end();
  }

  /** Lets callers write `using obs = startSpan(...)`. Sugar over end(). */
  [Symbol.dispose](): void {
    this.end();
  }
}

function configure(observation: Observation, options: SpanOptions): Observation {
  if (options.input !== undefined) observation.setInput(options.input);
  return observation;
}

/**
 * Create a span and return a handle. You MUST call end() (or use `using`).
 * The span is parented to whatever is current but does NOT become current.
 */
export function startSpan(name: string, options: SpanOptions = {}): Observation {
  const span = getTracer().startSpan(name, {
    attributes: kindAttributes(options.kind ?? SpanKind.CHAIN),
  });
  return configure(new Observation(span), options);
}

/**
 * Run `fn` with a new span active, so spans created inside it nest under this
 * one across async boundaries. Auto-ends, records exceptions, rethrows.
 */
export function startAsCurrentSpan<T>(
  name: string,
  options: SpanOptions,
  fn: (observation: Observation) => Promise<T> | T,
): Promise<T> {
  return getTracer().startActiveSpan(
    name,
    { attributes: kindAttributes(options.kind ?? SpanKind.CHAIN) },
    async (span) => {
      const observation = configure(new Observation(span), options);
      try {
        return await fn(observation);
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
        throw error;
      } finally {
        observation.end();
      }
    },
  );
}
