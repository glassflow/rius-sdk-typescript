import { SpanKind as OtelSpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  ERROR_TYPE,
  ERROR_TYPE_TOOL_ERROR,
  MCP_METHOD_NAME,
  MCP_METHOD_TOOLS_CALL,
  MCP_PROTOCOL_VERSION,
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
function serializeResult(result: unknown): string {
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
 * leak conversation content onto a tool span. Interim rounds record nothing
 * here (they stay identifiable as tool spans carrying `mcp.method.name`); the
 * final round records output as usual.
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
  if (resultType === INPUT_REQUIRED) return;
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
    connect?(transport: unknown, ...rest: unknown[]): Promise<unknown>;
  };
}

type CallTool = McpClientLike["prototype"]["callTool"];
type Connect = NonNullable<McpClientLike["prototype"]["connect"]>;

/**
 * The protocol version each client negotiated, captured while it connects.
 * Weak keys: the client owns its lifetime, and this must never keep one alive.
 */
const negotiatedVersions = new WeakMap<object, string>();

/**
 * Watch the version `Client.connect` hands its transport, for the duration of
 * one connect. The SDK's `Client` keeps nothing of the initialize result's
 * version itself: it validates it, then passes it to the transport's
 * `setProtocolVersion` only when the transport has one (the HTTP transports
 * do; stdio, WebSocket and in-memory do not). A temporary own
 * `setProtocolVersion` on the transport sees the value on every transport,
 * delegating to the transport's real method when there is one, and is removed
 * when the connect settles, so the transport is left exactly as it was.
 *
 * Returns the restore function. Never throws: a transport that cannot take an
 * own property (frozen, or not an object) is simply not watched.
 */
function watchProtocolVersion(client: object, transport: unknown): () => void {
  const target = asRecord(transport);
  if (target === undefined) return () => {};
  const hadOwn = Object.hasOwn(target, "setProtocolVersion");
  const previous = target.setProtocolVersion;
  try {
    target.setProtocolVersion = function watchedSetProtocolVersion(
      this: unknown,
      version: unknown,
    ): unknown {
      if (typeof version === "string") negotiatedVersions.set(client, version);
      return typeof previous === "function" ? previous.call(this, version) : undefined;
    };
  } catch {
    return () => {};
  }
  return () => {
    try {
      // Deleted, not set to undefined: an own undefined would hide the
      // transport's real method on its prototype (the HTTP transports').
      if (hadOwn) target.setProtocolVersion = previous;
      else Reflect.deleteProperty(target, "setProtocolVersion");
    } catch {
      // Nothing to restore on a transport that refused the change.
    }
  };
}

/**
 * The protocol version the client negotiated, if known. First the value
 * captured while the client connected (see watchProtocolVersion), which
 * covers every transport, as the Python SDK's session does. A reconnect that
 * skips initialize keeps it. Then, for a client connected before
 * instrumentation, the transport's own public `protocolVersion`, which only
 * `StreamableHTTPClientTransport` exposes. Otherwise the attribute is omitted,
 * never guessed from the version we requested.
 */
function negotiatedProtocolVersion(client: unknown): string | undefined {
  const record = asRecord(client);
  if (record === undefined) return undefined;
  const captured = negotiatedVersions.get(record);
  if (captured !== undefined) return captured;
  const version = asRecord(record.transport)?.protocolVersion;
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

/** The same marker on the connect wrapper. */
interface InstrumentedConnect extends Connect {
  riusOriginal?: Connect;
}

/**
 * Wrap `connect` so the negotiated protocol version is captured. Returns the
 * restore function, or a no-op when the class has no `connect` (a test double)
 * or it is already wrapped (the existing wrapper's own restore applies).
 */
function instrumentConnect(ClientClass: McpClientLike): () => void {
  const proto = ClientClass.prototype;
  const current = proto.connect as InstrumentedConnect | undefined;
  if (typeof current !== "function") return () => {};
  const alreadyWrapped = current.riusOriginal;
  if (alreadyWrapped !== undefined) {
    return () => {
      proto.connect = alreadyWrapped;
    };
  }
  const original = current;
  const instrumented: InstrumentedConnect = async function instrumentedConnect(
    this: unknown,
    transport: unknown,
    ...rest: unknown[]
  ): Promise<unknown> {
    const self = asRecord(this);
    const restore = self === undefined ? () => {} : watchProtocolVersion(self, transport);
    try {
      return await original.call(this, transport, ...rest);
    } finally {
      restore();
    }
  };
  instrumented.riusOriginal = original;
  proto.connect = instrumented;
  return () => {
    proto.connect = original;
  };
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
  const uninstallConnect = instrumentConnect(ClientClass);
  const current = ClientClass.prototype.callTool as InstrumentedCallTool;
  const alreadyWrapped = current.riusOriginal;
  if (alreadyWrapped !== undefined) {
    return () => {
      ClientClass.prototype.callTool = alreadyWrapped;
      uninstallConnect();
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
        // Optional chaining: a call without params must reach the MCP SDK,
        // which rejects it, rather than throw here synchronously.
        toolName: params?.name,
        input: params?.arguments,
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
    uninstallConnect();
  };
}
