import { type SpanKind as OtelSpanKind, type Span, SpanStatusCode } from "@opentelemetry/api";
import { getTracer } from "./client.js";
import {
  ERROR_TYPE,
  GEN_AI_DATA_SOURCE_ID,
  GEN_AI_RETRIEVAL_DOCUMENTS,
  GEN_AI_RETRIEVAL_TOP_K,
  INPUT_VALUE,
  OUTPUT_VALUE,
  SpanKind,
  USER_ID,
  kindAttributes,
  otelSpanKind,
} from "./semconv.js";
import { errorType, toAttributeValue } from "./serde.js";
import { withUser } from "./user.js";

/** Options for {@link startSpan} and {@link startAsCurrentSpan}. */
export interface SpanOptions {
  kind?: SpanKind;
  /**
   * The OpenTelemetry `SpanKind` FIELD (INTERNAL, CLIENT, …), orthogonal to
   * `kind` above, which is our taxonomy attribute. Conventions set it per
   * operation, so by default it is derived from `kind` (see `otelSpanKind`);
   * set this to override, as the MCP wrapper does for a remote tool call.
   */
  otelKind?: OtelSpanKind;
  input?: unknown;
  /**
   * End-user identity (`user.id`). Sugar for `withUser`: set on this span at
   * creation and, for the scoped variant, on every span opened inside it.
   * To attribute a whole request, including auto-instrumented spans, prefer
   * `withUser` around the handler.
   */
  userId?: string;
  /**
   * The index, collection or knowledge base a RETRIEVER span searched, set as
   * `gen_ai.data_source.id`. Ignored on every other kind: the key means the
   * target of a retrieval, and putting it elsewhere would make the attribute
   * mean something different depending on the span. Omitted when not passed,
   * never guessed.
   */
  dataSourceId?: string;
  /**
   * How many documents a RETRIEVER span asked for, set as
   * `gen_ai.retrieval.top_k`. Ignored on every other kind. What came back is
   * not an option here: it is unknown at span creation, so it is recorded
   * afterwards with `Observation.setRetrievedDocuments`.
   */
  topK?: number;
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
   * Record what a retrieval returned, as `gen_ai.retrieval.documents`.
   *
   * The conventions define this as an array of objects, each with an optional
   * `id` and an optional `score`. Identifiers and relevance, never document
   * text, which is why it is not treated as content: it survives
   * `captureContent: false` the way token counts do. Put the retrieved text in
   * `setOutput` if you want it captured, and masking applies to it there.
   *
   * Unlike `dataSourceId` and `topK`, which describe the request and are
   * passed at span creation, this is only knowable once the search has run, so
   * it never reaches a pending snapshot.
   */
  setRetrievedDocuments(documents: unknown): this {
    this.span.setAttribute(GEN_AI_RETRIEVAL_DOCUMENTS, toAttributeValue(documents));
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
   * Record an error on the span, set ERROR status and `error.type`. This is
   * exactly what the `startAsCurrent*` helpers do on a thrown error, exposed
   * so the manual `start*` path does not have to reach through `.span` to
   * match it.
   *
   * `error.type` is Conditionally Required by the GenAI conventions on every
   * span that ends in an error, and every helper's throw path funnels through
   * here, so this is the one place that sets it. The error's name only, never
   * the message: it must stay low-cardinality and free of echoed content.
   *
   * Accepts `unknown` because that is what a `catch` binding is; a non-Error
   * throwable is wrapped so `recordException` still gets a real Error.
   */
  recordException(error: unknown): this {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    this.span.recordException(wrapped);
    this.span.setStatus({ code: SpanStatusCode.ERROR, message: wrapped.message });
    this.span.setAttribute(ERROR_TYPE, errorType(error));
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
function creationAttributes(name: string, options: SpanOptions): Record<string, string | number> {
  const kind = options.kind ?? SpanKind.CHAIN;
  const attributes: Record<string, string | number> = {
    ...kindAttributes(kind, name),
    ...options.attributes,
  };
  if (options.userId !== undefined) attributes[USER_ID] = options.userId;
  if (kind === SpanKind.RETRIEVER) {
    if (options.dataSourceId !== undefined)
      attributes[GEN_AI_DATA_SOURCE_ID] = options.dataSourceId;
    if (options.topK !== undefined) attributes[GEN_AI_RETRIEVAL_TOP_K] = options.topK;
  }
  return attributes;
}

/**
 * Create a span and return a handle. You MUST call end() (or use `using`).
 * The span is parented to whatever is current but does NOT become current.
 */
export function startSpan(name: string, options: SpanOptions = {}): Observation {
  const span = getTracer().startSpan(name, {
    kind: options.otelKind ?? otelSpanKind(options.kind ?? SpanKind.CHAIN),
    attributes: creationAttributes(name, options),
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

  return runActive(
    name,
    creationAttributes(name, options),
    options.userId,
    (span) => configure(new Observation(span), options),
    fn,
    options.otelKind ?? otelSpanKind(options.kind ?? SpanKind.CHAIN),
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
  // Widened from string-only for gen_ai.retrieval.top_k, the first numeric
  // identity attribute set at creation. OTel accepts either.
  attributes: Record<string, string | number>,
  userId: string | undefined,
  makeHandle: (span: Span) => H,
  fn: (handle: H) => Promise<T> | T,
  otelKind?: OtelSpanKind,
): Promise<T> {
  const run = () =>
    getTracer().startActiveSpan(name, { kind: otelKind, attributes }, async (span) => {
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
