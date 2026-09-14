import { type Span, SpanStatusCode } from "@opentelemetry/api";
import { getTracer } from "./client.js";
import { INPUT_VALUE, OUTPUT_VALUE, SpanKind, USER_ID, kindAttributes } from "./semconv.js";
import { toAttributeValue } from "./serde.js";
import { withUser } from "./user.js";

/** Options for {@link startSpan} and {@link startAsCurrentSpan}. */
export interface SpanOptions {
  kind?: SpanKind;
  input?: unknown;
  /**
   * End-user identity (`user.id`). Sugar for `withUser`: set on this span at
   * creation and, for the scoped variant, on every span opened inside it.
   * To attribute a whole request, including auto-instrumented spans, prefer
   * `withUser` around the handler.
   */
  userId?: string;
  /**
   * Identity attributes to set at span CREATION rather than after it. Pending
   * snapshots are built at start, so anything a caller would otherwise
   * `setAttribute` first thing (a tool name, say) belongs here to reach them.
   * Content never does: it is not known at start and would bypass masking's
   * assumptions about where content lives.
   */
  attributes?: Record<string, string>;
}

// `Symbol.dispose` is undefined on Node 18.0 to 18.17 (added in 18.18 / 20.4)
// and `engines` allows >=18. Without it the method below would be keyed
// "undefined" and `using` would throw "not disposable". The TS helper falls
// back to this same well-known symbol, so installing it here keeps both sides
// agreeing; on newer Node it is already defined and this is a no-op.
(Symbol as { dispose?: symbol }).dispose ??= Symbol.for("Symbol.dispose");

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

  /**
   * Set an arbitrary attribute. Primitives and homogeneous primitive arrays
   * are passed through as the OTel values they are; objects are JSON-encoded
   * and bounded; `undefined` and `null` set nothing, since "no value" is not
   * an empty string.
   */
  setAttribute(key: string, value: unknown): this {
    if (value === undefined || value === null) return this;
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      this.span.setAttribute(key, value as string[]);
      return this;
    }
    if (Array.isArray(value) && value.every((v) => typeof v === "number")) {
      this.span.setAttribute(key, value as number[]);
      return this;
    }
    if (Array.isArray(value) && value.every((v) => typeof v === "boolean")) {
      this.span.setAttribute(key, value as boolean[]);
      return this;
    }
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
 * Identity attributes at CREATION so pending snapshots (onStart) carry them.
 * The user id is set here as well as via the `withUser` scope so it reaches
 * the span even on a provider without `UserSpanProcessor` installed.
 */
function creationAttributes(options: SpanOptions): Record<string, string> {
  const attributes = { ...kindAttributes(options.kind ?? SpanKind.CHAIN), ...options.attributes };
  if (options.userId !== undefined) attributes[USER_ID] = options.userId;
  return attributes;
}

/**
 * Create a span and return a handle. You MUST call end() (or use `using`).
 * The span is parented to whatever is current but does NOT become current.
 */
export function startSpan(name: string, options: SpanOptions = {}): Observation {
  const span = getTracer().startSpan(name, { attributes: creationAttributes(options) });
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

  return runActive(
    name,
    creationAttributes(options),
    options.userId,
    (span) => configure(new Observation(span), options),
    fn,
  );
}

/**
 * The one scoped-span runner, shared with the generation helpers: start the
 * span active with `attributes`, hand `makeHandle(span)` to `fn`, record a
 * throw as an exception and rethrow, always end. `userId` is sugar for
 * `withUser` around the whole thing, so children opened inside inherit it
 * through UserSpanProcessor while this span gets it at creation.
 *
 * @internal Not re-exported from the package entry point.
 */
export function runActive<H extends Observation, T>(
  name: string,
  attributes: Record<string, string>,
  userId: string | undefined,
  makeHandle: (span: Span) => H,
  fn: (handle: H) => Promise<T> | T,
): Promise<T> {
  const run = () =>
    getTracer().startActiveSpan(name, { attributes }, async (span) => {
      const handle = makeHandle(span);
      try {
        return await fn(handle);
      } catch (error) {
        handle.recordException(error);
        throw error;
      } finally {
        handle.end();
      }
    });
  return userId !== undefined ? withUser(userId, run) : run();
}
