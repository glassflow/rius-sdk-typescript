import { SpanKind as OtelSpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  ERROR_TYPE,
  ERROR_TYPE_TOOL_ERROR,
  MCP_METHOD_NAME,
  MCP_METHOD_TOOLS_CALL,
  MCP_PROTOCOL_VERSION,
  MCP_RESULT_TYPE,
  OUTPUT_VALUE,
  SpanKind,
} from "./semconv.js";
import { asRecord, toAttributeValue, truncate } from "./serde.js";
import { type Observation, startAsCurrentSpan } from "./spans.js";

/**
 * Best-effort rendering of a CallToolResult as `output.value`, matching the
 * Python SDK's `_serialize_result`: structured content when present (either
 * spelling, mcp 2.x snake_case or 1.x camelCase), else a lone text block raw
 * (it usually IS the answer, bounded like every attribute), else the list of
 * text blocks, else the whole result.
 */
function serializeResult(result: unknown): string | number | boolean {
  const record = asRecord(result);
  if (record === undefined) return toAttributeValue(result);
  const structured = record.structured_content ?? record.structuredContent;
  if (structured !== undefined && structured !== null) return toAttributeValue(structured);
  const content = record.content;
  if (Array.isArray(content)) {
    const texts = content
      .map((block) => asRecord(block)?.text)
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
  const record = asRecord(result);
  return Boolean(record?.is_error ?? record?.isError);
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
  const record = asRecord(result);
  const resultType = record?.result_type ?? record?.resultType;
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
    observation.setAttribute(ERROR_TYPE, ERROR_TYPE_TOOL_ERROR);
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

/**
 * The protocol version the client's transport negotiated, if it exposes one.
 * Read structurally off the client instance: the SDK's `Client` publishes its
 * transport via a `transport` getter, and only `StreamableHTTPClientTransport`
 * exposes the negotiated version as a public `protocolVersion` getter. The
 * SSE transport keeps it private, and stdio/WebSocket never receive it at
 * all (`Client.connect` forwards it only to transports with a
 * `setProtocolVersion` and retains nothing itself), so on those the
 * attribute is omitted — never guessed from the version we requested. This
 * is narrower than the Python SDK, whose session exposes the version on
 * every transport; a Recommended attribute, accepted for now.
 */
function negotiatedProtocolVersion(client: unknown): string | undefined {
  const version = asRecord(asRecord(client)?.transport)?.protocolVersion;
  return typeof version === "string" ? version : undefined;
}

/**
 * The protocol identity of a tools/call span, for setting at CREATION.
 * Pending snapshots are built at start, so anything set inside the callback
 * never reaches them — that includes the MCP marker, which an interim
 * input-required round must carry as much as a final one.
 *
 * The tool name is NOT here: it travels as the span helper's own `toolName`
 * input, so it stays correct however the span name is composed.
 */
function callAttributes(protocolVersion: string | undefined): Record<string, string> {
  const attributes: Record<string, string> = {
    [MCP_METHOD_NAME]: MCP_METHOD_TOOLS_CALL,
  };
  if (protocolVersion !== undefined) attributes[MCP_PROTOCOL_VERSION] = protocolVersion;
  return attributes;
}

/** Marks a wrapper with the true original, so a second wrap is detectable. */
interface InstrumentedCallTool extends CallTool {
  riusOriginal?: CallTool;
}

/**
 * Wrap an MCP client's callTool so every tool invocation becomes a TOOL span.
 * Mirrors instrumentation_mcp.py, which wraps ClientSession.call_tool.
 *
 * The span carries the OTel MCP semantic conventions (`mcp.method.name`,
 * `mcp.protocol.version`) so it is identifiable AS an MCP call — a local TOOL
 * span is otherwise identical. How it composes the two conventions it sits
 * under:
 *
 * - The OTel `SpanKind` field is CLIENT, the MCP client-span value. The two
 *   conventions disagree here: the GenAI execute-tool span says INTERNAL, the
 *   MCP client span says CLIENT. CLIENT wins because the call crosses a
 *   process boundary and the MCP convention is the more specific one; a
 *   local TOOL span stays INTERNAL. That field is orthogonal to
 *   `openinference.span.kind=TOOL`, our taxonomy attribute, which stays.
 * - The name is the GenAI execute-tool one, `execute_tool {tool}`, not the
 *   MCP `tools/call {tool}`. The MCP convention resolves that collision by
 *   consolidation: when a tool-execution span already exists, MCP
 *   instrumentation SHOULD NOT open a second span and SHOULD add its
 *   attributes to the existing one — which is exactly this span.
 *
 * Server identity (`server.address`) is deliberately not read: the only place
 * the URL lives is a private field of the HTTP transport.
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
    // Unnamed on purpose: the span helpers compose `execute_tool <name>` from
    // `toolName` below, which is the same string this used to build by hand
    // and the same one the Python SDK produces. One composer means the manual
    // helpers and this wrapper cannot drift apart, in either language.
    return startAsCurrentSpan(
      {
        kind: SpanKind.TOOL,
        // The OTel SpanKind FIELD (orthogonal to our taxonomy attribute above):
        // a remote tool call is CLIENT under both the MCP and the GenAI
        // execute-tool conventions.
        otelKind: OtelSpanKind.CLIENT,
        toolName: params.name,
        input: params.arguments,
        attributes: callAttributes(negotiatedProtocolVersion(this)),
      },
      async (observation) => {
        // A throw needs nothing here: the span runner records the exception,
        // ERROR status and error.type for every scoped span, then rethrows.
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
