import { type Span, SpanStatusCode } from "@opentelemetry/api";
import { getTracer } from "./client.js";
import { INPUT_VALUE, OUTPUT_VALUE, SpanKind, kindAttributes } from "./semconv.js";
import { toAttributeValue } from "./serde.js";

/** Options for {@link startSpan} and {@link startAsCurrentSpan}. */
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

  /**
   * Record an error on the span and set ERROR status. This is exactly what the
   * `startAsCurrent*` helpers do on a thrown error, exposed so the manual
   * `start*` path does not have to reach through `.span` to match it.
   *
   * Accepts `unknown` because that is what a `catch` binding is; a non-Error
   * throwable is wrapped so `recordException` still gets a real Error.
   */
  recordException(error: unknown): this {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    this.span.recordException(wrapped);
    this.span.setStatus({ code: SpanStatusCode.ERROR, message: wrapped.message });
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

/** The body of a scoped span. */
export type SpanBody<T> = (observation: Observation) => Promise<T> | T;

/**
 * Run `fn` with a new span active, so spans created inside it nest under this
 * one across async boundaries. Auto-ends, records exceptions, rethrows.
 *
 * `options` is optional, so the common case is `startAsCurrentSpan(name, fn)`
 * rather than `startAsCurrentSpan(name, {}, fn)`. The callback stays last.
 */
export function startAsCurrentSpan<T>(name: string, fn: SpanBody<T>): Promise<T>;
export function startAsCurrentSpan<T>(
  name: string,
  options: SpanOptions,
  fn: SpanBody<T>,
): Promise<T>;
export function startAsCurrentSpan<T>(
  name: string,
  optionsOrFn: SpanOptions | SpanBody<T>,
  maybeFn?: SpanBody<T>,
): Promise<T> {
  const [options, fn] =
    typeof optionsOrFn === "function"
      ? [{} as SpanOptions, optionsOrFn]
      : [optionsOrFn, maybeFn as SpanBody<T>];

  return getTracer().startActiveSpan(
    name,
    { attributes: kindAttributes(options.kind ?? SpanKind.CHAIN) },
    async (span) => {
      const observation = configure(new Observation(span), options);
      try {
        return await fn(observation);
      } catch (error) {
        observation.recordException(error);
        throw error;
      } finally {
        observation.end();
      }
    },
  );
}
