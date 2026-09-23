import { SpanKind } from "./semconv.js";
import type { Observation } from "./spans.js";
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

  const wrapped = (...args: Parameters<F>): Promise<R> => {
    const spanOptions = {
      kind: options.kind,
      toolName,
      dataSourceId: options.dataSourceId,
      topK: options.topK,
      agentName: options.agentName,
      agentId: options.agentId,
      // {args, kwargs} is the Python SDK's shape; JavaScript has no keyword
      // arguments, so kwargs is always empty, but the key stays so a saved
      // search or a console view reads both SDKs' input.value the same way.
      input: captureInput ? { args, kwargs: {} } : undefined,
    };
    const body = async (observation: Observation): Promise<R> => {
      const result = (await fn(...(args as never[]))) as R;
      if (captureOutput && result !== undefined) observation.setOutput(result);
      return result;
    };
    // Two calls rather than one with an optional name: the span helpers keep
    // the callback last, so "no name" is a different overload, not an
    // undefined first argument.
    return name === undefined
      ? startAsCurrentSpan<R>(spanOptions, body)
      : startAsCurrentSpan<R>(name, spanOptions, body);
  };

  // The wrapper should look like what it wraps: its own name, or the
  // function's, never the composed span name — `execute_tool x` is a span
  // name, not an identifier.
  Object.defineProperty(wrapped, "name", {
    value: name ?? (fn.name || "anonymous"),
    configurable: true,
  });
  return wrapped;
}
