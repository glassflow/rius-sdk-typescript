import { GEN_AI_TOOL_NAME, MCP_RESULT_TYPE, SpanKind } from "./semconv.js";
import { type Observation, startAsCurrentSpan } from "./spans.js";

/** The interim result type of a tools/call round that is asking for input. */
const INPUT_REQUIRED = "input_required";

/**
 * Record a tools/call result on the span.
 *
 * An interim input-required result is NOT the tool's output: its input requests
 * carry elicitation/sampling content, so recording them as `output.value` would
 * leak conversation content onto a tool span. Interim rounds get only the
 * `mcp.result_type` marker; the final round records output as usual.
 *
 * Both `result_type` and `resultType` are read. `result_type` is the spelling
 * seen on the wire; `resultType` is a speculative fallback in case a server
 * or SDK ever camelCases it, since the result shape here is loosely typed and
 * not guaranteed to stay snake_case. Kept even though no camelCase source is
 * currently known.
 */
function recordResult(observation: Observation, result: unknown): void {
  const resultType =
    typeof result === "object" && result !== null
      ? ((result as Record<string, unknown>).result_type ??
        (result as Record<string, unknown>).resultType)
      : undefined;
  if (resultType === INPUT_REQUIRED) {
    observation.setAttribute(MCP_RESULT_TYPE, INPUT_REQUIRED);
    return;
  }
  observation.setOutput(result);
}

/**
 * The slice of an MCP `Client` constructor this module needs: a prototype
 * carrying `callTool`. Structural on purpose, so a real
 * `@modelcontextprotocol/sdk` `Client` and a test double both satisfy it
 * without an import-time dependency on the package.
 */
export interface McpClientLike {
  prototype: {
    callTool(params: { name: string; arguments?: unknown }, ...rest: unknown[]): Promise<unknown>;
  };
}

type CallTool = McpClientLike["prototype"]["callTool"];

/** Marks a wrapper with the true original, so a second wrap is detectable. */
interface InstrumentedCallTool extends CallTool {
  riusOriginal?: CallTool;
}

/**
 * Wrap an MCP client's callTool so every tool invocation becomes a TOOL span.
 * Mirrors instrumentation_mcp.py, which wraps ClientSession.call_tool.
 *
 * Idempotent: calling this twice on the same class does not stack wrappers.
 * The second call detects the existing wrapper (via the marker it left on
 * itself) and hands back an uninstall tied to the same true original, so
 * either returned function restores the class to its pre-instrumentation
 * state.
 *
 * Returns a function that restores the original method.
 */
export function instrumentMcpClient(ClientClass: McpClientLike): () => void {
  const current = ClientClass.prototype.callTool as InstrumentedCallTool;
  const alreadyWrapped = current.riusOriginal;
  if (alreadyWrapped !== undefined) {
    return () => {
      ClientClass.prototype.callTool = alreadyWrapped;
    };
  }

  const original = ClientClass.prototype.callTool;

  const instrumented: InstrumentedCallTool = function instrumentedCallTool(
    this: unknown,
    params: { name: string; arguments?: unknown },
    ...rest: unknown[]
  ): Promise<unknown> {
    return startAsCurrentSpan(
      params.name,
      { kind: SpanKind.TOOL, input: params.arguments },
      async (observation) => {
        observation.setAttribute(GEN_AI_TOOL_NAME, params.name);
        const result = await original.call(this, params, ...rest);
        recordResult(observation, result);
        return result;
      },
    );
  };
  instrumented.riusOriginal = original;

  ClientClass.prototype.callTool = instrumented;

  return () => {
    ClientClass.prototype.callTool = original;
  };
}
