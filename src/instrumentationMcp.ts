import { SpanStatusCode } from "@opentelemetry/api";
import { GEN_AI_TOOL_NAME, MCP_RESULT_TYPE, OUTPUT_VALUE, SpanKind } from "./semconv.js";
import { toAttributeValue, truncate } from "./serde.js";
import { type Observation, startAsCurrentSpan } from "./spans.js";

/**
 * Best-effort rendering of a CallToolResult as `output.value`, matching the
 * Python SDK's `_serialize_result`: structured content when present (either
 * spelling, mcp 2.x snake_case or 1.x camelCase), else a lone text block raw
 * (it usually IS the answer, bounded like every attribute), else the list of
 * text blocks, else the whole result.
 */
function serializeResult(result: unknown): string | number | boolean {
  if (typeof result !== "object" || result === null) return toAttributeValue(result);
  const record = result as Record<string, unknown>;
  const structured = record.structured_content ?? record.structuredContent;
  if (structured !== undefined && structured !== null) return toAttributeValue(structured);
  const content = record.content;
  if (Array.isArray(content)) {
    const texts = content
      .map((block) =>
        typeof block === "object" && block !== null
          ? (block as { text?: unknown }).text
          : undefined,
      )
      .filter((text): text is string => typeof text === "string");
    if (texts.length === 1) return truncate(texts[0]);
    if (texts.length > 1) return toAttributeValue(texts);
  }
  return toAttributeValue(result);
}

/** The interim result type of a tools/call round that is asking for input. */
const INPUT_REQUIRED = "input_required";

/**
 * The MCP error-result flag, on either major. mcp 2.x spells it `is_error`;
 * 1.x spelled it `isError`. Never throws: the result shape is loosely typed.
 */
function resultIsError(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const record = result as Record<string, unknown>;
  return Boolean(record.is_error ?? record.isError);
}

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
  observation.setAttribute(OUTPUT_VALUE, serializeResult(result));
  // The protocol reports tool failures as a normal result carrying an error
  // flag, so a resolved call can still be a failure. The output above is kept:
  // the error content is exactly what a debugging user needs to see. Status
  // message matches the Python SDK's.
  if (resultIsError(result)) {
    observation.span.setStatus({
      code: SpanStatusCode.ERROR,
      message: "tool returned an error result",
    });
  }
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
    // `execute_tool <name>`, matching the Python SDK: the same tool call must
    // produce the same span name in every language, or cross-language
    // dashboards and saved searches split by SDK.
    return startAsCurrentSpan(
      `execute_tool ${params.name}`,
      // Tool name at CREATION: pending snapshots are built at start, so an
      // attribute set inside the callback never reaches them.
      {
        kind: SpanKind.TOOL,
        input: params.arguments,
        attributes: { [GEN_AI_TOOL_NAME]: params.name },
      },
      async (observation) => {
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
