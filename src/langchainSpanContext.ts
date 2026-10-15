import { context, type Span, trace } from "@opentelemetry/api";

/**
 * Nest a LangChain chat model's provider call under LangChain's span.
 *
 * OpenInference's JS LangChain instrumentation builds its spans from LangChain's
 * callbacks and never makes them current. A chat model's provider call, traced
 * by the provider's own instrumentation (openai, anthropic), therefore sees no
 * active span: its span is a root span in a trace of its own. One model call
 * then shows up in two traces, and the usage dedup in `aggregatedUsage`, which
 * relies on the provider span being the LangChain span's child, cannot see it,
 * so the call's usage is counted twice.
 *
 * This runs the model's own call under the LangChain span. Every chat model
 * call reaches the concrete model's `_generate` (non-streamed) or
 * `_streamResponseChunks` (streamed), and both receive the run manager, whose
 * run id names the span the instrumentation started for it. Those methods
 * belong to each concrete model class (ChatOpenAI, ChatAnthropic, ...), so the
 * base class's entry points (`_generateUncached`, `_streamIterator`) wrap the
 * concrete class's methods the first time a model of that class is used.
 *
 * The span is found through the run manager's handlers: the instrumentation's
 * tracer keeps `runs[runId].span`. That is a private detail, so it is read
 * defensively: when it is missing (a reshaped release, or the instrumentation
 * not enabled), the call runs exactly as before. Nothing here throws into the
 * caller's code, and the span is only active inside the model's own call: the
 * caller's code between stream chunks runs in its own context.
 *
 * LangChain runs callbacks in the background by default: the tracer records
 * the run at once, but starts its span in a callback queued on LangChain's
 * one-at-a-time callback queue, which may not have run yet when the model is
 * called (it has not when other calls keep the queue busy). When the run is
 * known but its span is not, the call first waits for a no-op queued behind
 * that callback, through LangChain's public `consumeCallback`, so the span is
 * there by the time the call starts. The wait is bounded: a call made from a
 * callback that is itself running on that queue (an evaluator calling a model
 * from handleLLMEnd) would otherwise wait for its own caller, forever.
 */

const WRAPPED = Symbol.for("rius.langchainSpanContext");

/**
 * How long a call waits for its pending span before running un-nested. The
 * queue normally drains in well under a millisecond; the bound covers a queue
 * that cannot drain before this call ends (the call is made from a callback
 * running on that queue) and caps what a busy queue adds to each call.
 */
export const PENDING_SPAN_WAIT_MS = 50;

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;
type Wrapped = AnyFunction & { [WRAPPED]?: AnyFunction };

interface RunManagerLike {
  runId?: string;
  handlers?: unknown[];
}

interface ChatModelModule {
  BaseChatModel?: { prototype: Record<string, unknown> };
}

/** `@langchain/core/callbacks/promises`, for its callback queue. */
interface CallbackPromisesModule {
  consumeCallback?: (callback: () => Promise<void>, wait: boolean) => unknown;
}

interface TracerLike {
  runs?: Record<string, { span?: Span }>;
  getRunById?: (runId: string) => unknown;
}

type Lookup = { span: Span } | { pending: true } | undefined;

/** The callback queue's `consumeCallback`. Set by install. */
let consumeCallback: CallbackPromisesModule["consumeCallback"];

/**
 * The span the instrumentation started for this run; or, when a tracer knows
 * the run but its queued start callback has not run yet, that it is pending.
 */
function lookUp(runManager: unknown): Lookup {
  try {
    const manager = runManager as RunManagerLike | undefined;
    const runId = manager?.runId;
    if (runId === undefined) return undefined;
    let pending = false;
    for (const handler of manager?.handlers ?? []) {
      const tracer = handler as TracerLike | undefined;
      const runs = tracer?.runs;
      if (runs === undefined || typeof runs !== "object") continue;
      const span = runs[runId]?.span;
      if (span !== undefined && typeof span.spanContext === "function") return { span };
      if (typeof tracer?.getRunById === "function" && tracer.getRunById(runId) !== undefined) {
        pending = true;
      }
    }
    return pending ? { pending: true } : undefined;
  } catch {
    // A reshaped private detail: run as if there were no span.
    return undefined;
  }
}

/**
 * Resolves once every callback LangChain queued before now has run, or after
 * {@link PENDING_SPAN_WAIT_MS}, whichever comes first.
 */
function queuedCallbacksRan(): Promise<void> | undefined {
  const consume = consumeCallback;
  if (consume === undefined) return undefined;
  return new Promise<void>((resolve) => {
    // Not unref'd: in the case the bound exists for, this timer is the only
    // thing that can move the call forward, and nothing else may be keeping a
    // short-lived process alive. It is cleared once the queue drains.
    const timer = setTimeout(resolve, PENDING_SPAN_WAIT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    try {
      consume(async () => done(), false);
    } catch {
      done();
    }
  });
}

function contextOf(span: Span | undefined) {
  if (span === undefined || trace.getActiveSpan() === span) return undefined;
  return trace.setSpan(context.active(), span);
}

/** The context to run the call under, waiting for a pending span first. */
async function contextFor(runManager: unknown) {
  let found = lookUp(runManager);
  if (found !== undefined && "pending" in found) {
    // Still pending after the wait: the call runs un-nested, as it would
    // without this module.
    await queuedCallbacksRan();
    found = lookUp(runManager);
  }
  return found !== undefined && "span" in found ? contextOf(found.span) : undefined;
}

function wrapGenerate(original: AnyFunction): Wrapped {
  const wrapped: Wrapped = function (this: unknown, ...args: unknown[]) {
    const found = lookUp(args[2]);
    if (found === undefined) return original.apply(this, args);
    if ("span" in found) {
      const ctx = contextOf(found.span);
      if (ctx === undefined) return original.apply(this, args);
      return context.with(ctx, () => original.apply(this, args));
    }
    // `_generate` returns a promise, so waiting first keeps its shape.
    return contextFor(args[2]).then((ctx) =>
      ctx === undefined
        ? original.apply(this, args)
        : context.with(ctx, () => original.apply(this, args)),
    );
  };
  wrapped[WRAPPED] = original;
  return wrapped;
}

function wrapStream(original: AnyFunction): Wrapped {
  const wrapped: Wrapped = async function* (this: unknown, ...args: unknown[]) {
    const ctx = await contextFor(args[2]);
    const steps = original.apply(this, args) as AsyncIterator<unknown>;
    if (ctx === undefined) {
      yield* { [Symbol.asyncIterator]: () => steps };
      return;
    }
    try {
      while (true) {
        // Each step runs under the span: the provider call starts inside the
        // first one. The caller's code between steps runs in its own context.
        const step = await context.with(ctx, () => steps.next());
        if (step.done) return step.value;
        yield step.value;
      }
    } finally {
      await steps.return?.();
    }
  } as unknown as Wrapped;
  wrapped[WRAPPED] = original;
  return wrapped;
}

const CONCRETE = {
  _generate: wrapGenerate,
  _streamResponseChunks: wrapStream,
} as const;

const ENTRY_POINTS = ["_generateUncached", "_streamIterator"] as const;

/** Every concrete-class method this module wrapped, to restore on uninstall. */
const wrappedOwners: Array<{ owner: Record<string, unknown>; name: string }> = [];

function ensureWrapped(model: unknown, base: Record<string, unknown>): void {
  for (const [name, wrap] of Object.entries(CONCRETE)) {
    let owner = Object.getPrototypeOf(model) as Record<string, unknown> | null;
    while (owner !== null && !Object.prototype.hasOwnProperty.call(owner, name)) {
      owner = Object.getPrototypeOf(owner) as Record<string, unknown> | null;
    }
    // The base class's own method is a stub the concrete class overrides.
    if (owner === null || owner === base) continue;
    const current = owner[name] as Wrapped | undefined;
    if (typeof current !== "function" || current[WRAPPED] !== undefined) continue;
    owner[name] = wrap(current);
    wrappedOwners.push({ owner, name });
  }
}

/**
 * Install on `@langchain/core/language_models/chat_models`, waiting for a
 * pending span through `@langchain/core/callbacks/promises` when given it.
 * Returns an uninstall; a no-op one when the module does not have the
 * expected shape.
 */
export function installLangchainSpanContext(
  module: ChatModelModule | undefined,
  promises?: CallbackPromisesModule,
): () => void {
  try {
    consumeCallback =
      typeof promises?.consumeCallback === "function" ? promises.consumeCallback : undefined;
    const base = module?.BaseChatModel?.prototype;
    if (base === undefined) return () => {};
    if (!ENTRY_POINTS.every((name) => typeof base[name] === "function")) return () => {};
    const replaced: Array<[string, Wrapped]> = [];
    for (const name of ENTRY_POINTS) {
      const current = base[name] as Wrapped;
      const original = current[WRAPPED] ?? current;
      const entry: Wrapped = function (this: unknown, ...args: unknown[]) {
        try {
          ensureWrapped(this, base);
        } catch {
          // Never let the hook break the call.
        }
        return original.apply(this, args);
      };
      entry[WRAPPED] = original;
      base[name] = entry;
      replaced.push([name, original]);
    }
    return () => {
      consumeCallback = undefined;
      for (const [name, original] of replaced) {
        if ((base[name] as Wrapped)[WRAPPED] === original) base[name] = original;
      }
      for (const { owner, name } of wrappedOwners.splice(0)) {
        const current = owner[name] as Wrapped;
        if (current[WRAPPED] !== undefined) owner[name] = current[WRAPPED];
      }
    };
  } catch {
    return () => {};
  }
}
