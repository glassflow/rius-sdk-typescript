import { context, trace } from "@opentelemetry/api";
import { resolveAgentName, withAgentScope } from "./agent.js";
import { SpanKind } from "./semconv.js";
import type { Observation, SpanOptions } from "./spans.js";
import { startAsCurrentSpan, startSpan } from "./spans.js";

/** Options for {@link observe}. */
export interface ObserveOptions {
  name?: string;
  kind?: SpanKind;
  /**
   * The tool name a TOOL-kind wrapper carries as `gen_ai.tool.name`. Defaults
   * to the span name, so a wrapped function whose name IS the tool name needs
   * nothing; pass it when the two differ.
   */
  toolName?: string;
  /**
   * The id of the model tool-call a TOOL-kind wrapper answers, set as
   * `gen_ai.tool.call.id`. Only the caller has it — a wrapper sees the
   * arguments, never the assistant message that produced them — so it is
   * passed or omitted, never derived. Ignored on every other kind.
   */
  toolCallId?: string;
  /**
   * What kind of tool a TOOL-kind wrapper runs, set as `gen_ai.tool.type`
   * (`"function"`, `"extension"`, `"datastore"`). Recorded verbatim and never
   * inferred from the wrapped callable: the wrapper shape says nothing about
   * where the tool actually executes. Ignored on every other kind.
   */
  toolType?: string;
  /**
   * The index, collection or knowledge base a RETRIEVER-kind wrapper searched,
   * set as `gen_ai.data_source.id`. Ignored on every other kind.
   */
  dataSourceId?: string;
  /**
   * How many documents a RETRIEVER-kind wrapper asked for, set as
   * `gen_ai.retrieval.top_k`. Ignored on every other kind.
   */
  topK?: number;
  /**
   * The agent an AGENT-kind wrapper invokes, set as `gen_ai.agent.name`.
   * Unset, it falls back to the agent name `init()` was given; it is never
   * taken from the wrapped function's name. Ignored on every other kind.
   *
   * It also scopes the call: TOOL spans opened while the wrapped function
   * runs carry this name as the agent that EXECUTED them, which is what the
   * same key means on an execute-tool span.
   */
  agentName?: string;
  /**
   * The invoked agent's identifier (`gen_ai.agent.id`). For a HOSTED agent
   * resource such as a Bedrock agent ARN; an in-process agent leaves it unset.
   */
  agentId?: string;
  /**
   * The invoked agent's version (`gen_ai.agent.version`): the version of the
   * agent definition, taken verbatim and never derived from the service
   * version or from the version of the agent this process is.
   */
  agentVersion?: string;
  captureInput?: boolean;
  captureOutput?: boolean;
}

/**
 * What a wrapped function returns: the generator itself for a generator or
 * async generator function, so `for (const x of fn())` and
 * `for await (const x of fn())` keep working, and a Promise of the original's
 * result for everything else.
 *
 * A generator function annotated with the iteration interface it implements
 * (`AsyncIterable<T>`, `AsyncIterableIterator<T>`, `Iterable<T>`,
 * `IterableIterator<T>`) keeps that declared type, so `.then()` on its
 * wrapper's result is a compile error. Only that exact interface counts: an
 * array, a string, a Set, a Map or a Node stream is iterable too, but a plain
 * function returning one is not a generator function at runtime and keeps its
 * Promise. A type cannot see the function kind, which leaves these cases
 * typed differently from what the wrapper returns at runtime:
 *
 * - A plain function annotated as returning exactly one of those interfaces
 *   is typed as an iterator but returns a Promise; give it the concrete type
 *   it returns.
 * - A plain function returning a built-in iterator (`arr.values()`,
 *   `map.entries()`, `set.values()`, `str.matchAll(re)`) is typed as that
 *   iterator but returns a Promise, when the consumer's `lib` predates the
 *   ES2025 iterator helpers: the type system then sees the iterator as
 *   exactly `IterableIterator<T>`. A `lib` that includes them (`ESNext`, or
 *   `ES2025` where the compiler has it) gives built-in iterators `map`,
 *   `filter` and the rest, so they are no longer exactly that interface and
 *   such a function is correctly typed as a Promise.
 * - A generator function annotated with a union such as
 *   `Iterable<T> | undefined` is typed as a Promise but returns a generator.
 *
 * Non-distributive (the tuple wrapping) so a union return type is not split,
 * and `any` stays a Promise: `any` would otherwise satisfy the generator arm
 * and turn every untyped callback's wrapper into a generator. `never` (a
 * function that only throws) is a Promise for the same reason.
 */
export type ObservedReturn<R> = 0 extends 1 & R
  ? Promise<R>
  : [R] extends [never]
    ? Promise<never>
    : [R] extends [AsyncGenerator<infer T, infer TReturn, infer TNext>]
      ? AsyncGenerator<T, TReturn, TNext>
      : [R] extends [Generator<infer T, infer TReturn, infer TNext>]
        ? Generator<T, TReturn, TNext>
        : IsIterationInterface<R> extends true
          ? R
          : Promise<Awaited<R>>;

/**
 * True when `R` is exactly one of the iteration interfaces a generator
 * function may be annotated with, not merely assignable to it: mutual
 * assignability tells the bare interface from a collection that has more
 * members (an array's `length`, a Set's `has`).
 */
type IsIterationInterface<R> = [R] extends [AsyncIterableIterator<infer T>]
  ? IsExactly<R, AsyncIterableIterator<T>>
  : [R] extends [AsyncIterable<infer T>]
    ? IsExactly<R, AsyncIterable<T>>
    : [R] extends [IterableIterator<infer T>]
      ? IsExactly<R, IterableIterator<T>>
      : [R] extends [Iterable<infer T>]
        ? IsExactly<R, Iterable<T>>
        : false;

type IsExactly<R, I> = [I] extends [R] ? true : false;

const GENERATOR_FUNCTION_TAG = "[object GeneratorFunction]";
const ASYNC_GENERATOR_FUNCTION_TAG = "[object AsyncGeneratorFunction]";

/**
 * Wrap a function so each call becomes a span. The returned function takes
 * the same parameters. For an ordinary function it returns a Promise of the
 * original's result (a synchronous function becomes asynchronous), so call
 * sites need an `await` but no other change.
 *
 * A generator function (`function*`) or async generator function
 * (`async function*`) stays one: the wrapper returns a generator, and the span
 * covers the whole iteration. It opens on the first step and ends when the
 * iteration finishes, throws, or is closed early (`break`, `return()`), which
 * also closes the wrapped generator so its `finally` blocks run. The span is
 * current only while the generator's own code runs, never in the caller
 * between steps. A generator records its input but no output: what it yields
 * is a stream, not a value, which is what the Python SDK does too.
 *
 * A generator abandoned mid-iteration, dropped without finishing or being
 * closed, has its span ended when the garbage collector reclaims it, timed at
 * its last step, as Python ends it at collection. That is best effort: the
 * collector decides when, or whether, it runs, so until then (and for good if
 * the process exits first) the span stays open and is reported as pending.
 * The wrapped generator's own `finally` blocks do not run. Close a generator
 * you stop iterating early (`return()`, or `break` out of a loop) for an exact
 * end.
 *
 * Generators are recognised by function kind, as Python recognises them, so a
 * plain function that returns a generator built elsewhere is an ordinary
 * function to `observe`; wrap the generator function itself instead. Code
 * compiled to a target older than ES2018 turns async generator functions into
 * plain ones, which are then treated the same way.
 *
 * A wrapper rather than a decorator on purpose: TypeScript decorators apply
 * only to class members, and most agent code is plain functions.
 */
export function observe<F extends (...args: never[]) => unknown>(
  fn: F,
  options: ObserveOptions = {},
): (...args: Parameters<F>) => ObservedReturn<ReturnType<F>> {
  // Named alias so every use below refers to the identical deferred type.
  // Without it, TS re-derives `Awaited<ReturnType<F>>` at each site and,
  // because F is an unresolved generic, fails to see the two derivations as
  // the same type (TS2322: "ReturnType<F> is not assignable to
  // Awaited<ReturnType<F>>") even though they are.
  type R = Awaited<ReturnType<F>>;

  const kind = options.kind ?? SpanKind.CHAIN;
  // A CHAIN has no operation to compose a name from, so the wrapped
  // function's name stays its span name — the behaviour every existing
  // caller has. Every other kind gets the conventions' `{operation}
  // {target}` name, composed per call in the span helpers, so passing no
  // name here is how we ask for it.
  const name = options.name ?? (kind === SpanKind.CHAIN ? fn.name || "anonymous" : undefined);
  // The wrapped function IS the tool, so its name is the tool's name — fed in
  // as the tool name rather than as the span name, which both keeps
  // `gen_ai.tool.name` bare (never the rendered `execute_tool x`) and avoids
  // the span-name-as-tool-name deprecation warning, since nothing is being
  // reused here. A caller who named the span keeps the old coupling, name and
  // warning included: silently renaming their tool would split its metrics.
  const toolName =
    options.toolName ??
    (kind === SpanKind.TOOL && name === undefined ? fn.name || undefined : undefined);
  const captureInput = options.captureInput ?? true;
  const captureOutput = options.captureOutput ?? true;

  const spanOptionsFor = (args: Parameters<F>): SpanOptions => ({
    kind: options.kind,
    toolName,
    toolCallId: options.toolCallId,
    toolType: options.toolType,
    dataSourceId: options.dataSourceId,
    topK: options.topK,
    agentName: options.agentName,
    agentId: options.agentId,
    agentVersion: options.agentVersion,
    // {args, kwargs} is the Python SDK's shape; JavaScript has no keyword
    // arguments, so kwargs is always empty, but the key stays so a saved
    // search or a console view reads both SDKs' input.value the same way.
    input: captureInput ? { args, kwargs: {} } : undefined,
  });

  // `function`s, not arrows, so a wrapped method keeps its receiver:
  // `{ run: observe(async function () { return this.name }) }.run()` must see
  // the object it was called on.
  const callWrapper = function (this: unknown, ...args: Parameters<F>): Promise<R> {
    const spanOptions = spanOptionsFor(args);
    const body = async (observation: Observation): Promise<R> => {
      const result = (await fn.apply(this, args as never[])) as R;
      // An undefined result is recorded too, as "null": Python records the
      // None a function without a return gives back.
      if (captureOutput) observation.setOutput(result);
      return result;
    };
    // Two calls rather than one with an optional name: the span helpers keep
    // the callback last, so "no name" is a different overload, not an
    // undefined first argument.
    return name === undefined
      ? startAsCurrentSpan<R>(spanOptions, body)
      : startAsCurrentSpan<R>(name, spanOptions, body);
  };

  const generatorWrapper = function* (
    this: unknown,
    ...args: Parameters<F>
  ): Generator<unknown, unknown, unknown> {
    // Opened here, on the first step, rather than when the wrapper is
    // called: a generator that is never iterated runs none of its code and
    // should leave no span behind, pending or otherwise.
    const step = openIterationSpan(name, spanOptionsFor(args), options.agentName);
    const abandonment = watchAbandonment(step.observation);
    // Calling the generator function runs its parameter destructuring and
    // default values, which may throw, so it is inside the try that records
    // the error and ends the span.
    let inner: Generator | undefined;
    let resume: Resume = { throwing: false, value: undefined };
    try {
      const generator = step.run(() => fn.apply(this, args as never[]) as Generator);
      inner = generator;
      while (true) {
        const result = step.run(() =>
          resume.throwing ? generator.throw(resume.value) : generator.next(resume.value),
        );
        if (result.done) return result.value;
        abandonment.lease.lastStep = performance.now();
        try {
          resume = { throwing: false, value: yield result.value };
        } catch (thrown) {
          // The caller's throw(): hand it to the generator, which may catch it.
          resume = { throwing: true, value: thrown };
        }
      }
    } catch (error) {
      step.observation.recordException(error);
      throw error;
    } finally {
      // Reached on completion, on a throw, and on the caller's return()
      // (a `break` out of for-of). Closing an already finished generator is a
      // no-op; closing a suspended one runs its finally blocks now.
      abandonment.release();
      closeIteration(step, () => inner?.return(undefined));
    }
  };

  const asyncGeneratorWrapper = async function* (
    this: unknown,
    ...args: Parameters<F>
  ): AsyncGenerator<unknown, unknown, unknown> {
    // See the synchronous wrapper; this is the same loop with awaits.
    const step = openIterationSpan(name, spanOptionsFor(args), options.agentName);
    const abandonment = watchAbandonment(step.observation);
    let inner: AsyncGenerator | undefined;
    let resume: Resume = { throwing: false, value: undefined };
    try {
      const generator = step.run(() => fn.apply(this, args as never[]) as AsyncGenerator);
      inner = generator;
      while (true) {
        // Calling next() inside the step's context is enough for the body's
        // own awaits: async continuations keep the context they started in.
        const result = await step.run(() =>
          resume.throwing ? generator.throw(resume.value) : generator.next(resume.value),
        );
        if (result.done) return result.value;
        abandonment.lease.lastStep = performance.now();
        try {
          resume = { throwing: false, value: yield result.value };
        } catch (thrown) {
          resume = { throwing: true, value: thrown };
        }
      }
    } catch (error) {
      step.observation.recordException(error);
      throw error;
    } finally {
      abandonment.release();
      await closeAsyncIteration(step, () => inner?.return(undefined));
    }
  };

  const tag = Object.prototype.toString.call(fn);
  const wrapped =
    tag === GENERATOR_FUNCTION_TAG
      ? generatorWrapper
      : tag === ASYNC_GENERATOR_FUNCTION_TAG
        ? asyncGeneratorWrapper
        : callWrapper;

  // The wrapper should look like what it wraps: its own name, or the
  // function's, never the composed span name — `execute_tool x` is a span
  // name, not an identifier.
  Object.defineProperty(wrapped, "name", {
    value: name ?? (fn.name || "anonymous"),
    configurable: true,
  });
  // The arms differ only in the shape ObservedReturn selects for this F,
  // which TypeScript cannot follow through the runtime tag check.
  return wrapped as unknown as (...args: Parameters<F>) => ObservedReturn<ReturnType<F>>;
}

/** How the next step resumes the wrapped generator: a value to send, or a throw. */
interface Resume {
  throwing: boolean;
  value: unknown;
}

/**
 * Start the span a wrapped generator's iteration runs under, and the means to
 * run each step inside it.
 *
 * The span is created inactive and made current only around each call into
 * the generator, because between steps control is back in the caller, whose
 * spans must not nest under the generator's. An AGENT generator scopes its
 * invoked name over those same steps, as the scoped helper does over its
 * callback, so the TOOL spans it opens say which agent executed them.
 */
function openIterationSpan(
  name: string | undefined,
  spanOptions: SpanOptions,
  agentName: string | undefined,
): { observation: Observation; run: <T>(fn: () => T) => T } {
  const observation = name === undefined ? startSpan(spanOptions) : startSpan(name, spanOptions);
  const scopeName = resolveAgentName(agentName, spanOptions.kind ?? SpanKind.CHAIN);
  const run = <T>(fn: () => T): T =>
    context.with(trace.setSpan(context.active(), observation.span), () =>
      scopeName === undefined ? fn() : withAgentScope(scopeName, fn),
    );
  return { observation, run };
}

type IterationStep = ReturnType<typeof openIterationSpan>;

/**
 * Close the wrapped generator inside its step, then end the span. Closing a
 * suspended generator runs its finally blocks, which may throw; the wrapper's
 * own catch has already run by then, so the error is recorded here before it
 * reaches the caller.
 */
function closeIteration(step: IterationStep, close: () => unknown): void {
  try {
    step.run(close);
  } catch (error) {
    step.observation.recordException(error);
    throw error;
  } finally {
    step.observation.end();
  }
}

/** {@link closeIteration} for an async generator. */
async function closeAsyncIteration(
  step: IterationStep,
  close: () => Promise<unknown> | undefined,
): Promise<void> {
  try {
    await step.run(close);
  } catch (error) {
    step.observation.recordException(error);
    throw error;
  } finally {
    step.observation.end();
  }
}

/**
 * What the finalizer needs to end an abandoned iteration's span: the span, and
 * when the generator last handed control back to its caller, on the
 * `performance.now()` clock the span's own timestamps are anchored to.
 */
export interface AbandonedIteration {
  observation: Observation;
  lastStep: number;
}

/**
 * End the span of a wrapped generator that was garbage collected mid-iteration.
 *
 * Timed at the last step rather than now: the time a generator spends
 * abandoned, until a collection happens to find it, is not time it spent
 * working. Never throws, because a finalizer that throws reaches the host as
 * an uncaught exception.
 */
export function endAbandonedIteration(abandoned: AbandonedIteration): void {
  try {
    abandoned.observation.span.end(abandoned.lastStep);
  } catch {
    // Nothing to report to: the generator is gone, and so is its caller.
  }
}

// Absent on runtimes without weak references; abandoned spans then stay open,
// as they always did.
const abandonedIterations =
  typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry<AbandonedIteration>(endAbandonedIteration)
    : undefined;

/**
 * Arrange for the iteration's span to end if its generator is collected before
 * the wrapper's `finally` runs.
 *
 * The registry cannot watch the generator object itself, which a generator's
 * body has no reference to. It watches a token instead that only the
 * wrapper's frame holds, kept alive by `release()` in the `finally`: the token
 * becomes unreachable exactly when the suspended generator does. The lease is
 * what the registry holds strongly, so it carries the span and never the
 * generator, which would otherwise keep itself alive.
 */
function watchAbandonment(observation: Observation): {
  lease: AbandonedIteration;
  release: () => void;
} {
  const lease: AbandonedIteration = { observation, lastStep: performance.now() };
  const token = {};
  abandonedIterations?.register(token, lease, token);
  return { lease, release: () => abandonedIterations?.unregister(token) };
}
