import type { SpanKind } from "./semconv.js";
import { startAsCurrentSpan } from "./spans.js";

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
   */
  agentName?: string;
  /** The invoked agent's stable identifier (`gen_ai.agent.id`), if any. */
  agentId?: string;
  captureInput?: boolean;
  captureOutput?: boolean;
}

/**
 * Wrap a function so each call becomes a span. The returned function takes
 * the same parameters and always returns a Promise of the original's result
 * (a synchronous function becomes asynchronous), so call sites need an
 * `await` but no other change.
 *
 * A wrapper rather than a decorator on purpose: TypeScript decorators apply
 * only to class members, and most agent code is plain functions.
 */
export function observe<F extends (...args: never[]) => unknown>(
  fn: F,
  options: ObserveOptions = {},
): (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>> {
  // Named alias so every use below refers to the identical deferred type.
  // Without it, TS re-derives `Awaited<ReturnType<F>>` at each site and,
  // because F is an unresolved generic, fails to see the two derivations as
  // the same type (TS2322: "ReturnType<F> is not assignable to
  // Awaited<ReturnType<F>>") even though they are.
  type R = Awaited<ReturnType<F>>;

  const name = options.name ?? (fn.name || "anonymous");
  const captureInput = options.captureInput ?? true;
  const captureOutput = options.captureOutput ?? true;

  const wrapped = (...args: Parameters<F>): Promise<R> =>
    startAsCurrentSpan<R>(
      name,
      // {args, kwargs} is the Python SDK's shape; JavaScript has no keyword
      // arguments, so kwargs is always empty, but the key stays so a saved
      // search or a console view reads both SDKs' input.value the same way.
      {
        kind: options.kind,
        toolName: options.toolName,
        dataSourceId: options.dataSourceId,
        topK: options.topK,
        agentName: options.agentName,
        agentId: options.agentId,
        input: captureInput ? { args, kwargs: {} } : undefined,
      },
      async (observation): Promise<R> => {
        const result = (await fn(...(args as never[]))) as R;
        if (captureOutput && result !== undefined) observation.setOutput(result);
        return result;
      },
    );

  Object.defineProperty(wrapped, "name", { value: name, configurable: true });
  return wrapped;
}
