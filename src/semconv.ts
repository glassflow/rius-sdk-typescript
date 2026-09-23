import { SpanKind as OtelSpanKind } from "@opentelemetry/api";

/**
 * Wire-visible instrumentation scope name. "rius" since the vendor keys were
 * normalized under the product name; it was "glassflow" before. Nothing in the
 * backend keys on it: the sink stores the scope name verbatim and no reader
 * filters on it, so both values coexist in stored data.
 */
export const TRACER_NAME = "rius";

// OTel standard resource attribute: identity of one process lifetime (one
// uuid per client, minted at init). The heartbeat payload's instance_id
// carries the SAME value, which is what lets the backend join heartbeats to
// traces and count replicas.
export const SERVICE_INSTANCE_ID = "service.instance.id";

// OpenInference
export const OPENINFERENCE_SPAN_KIND = "openinference.span.kind";
export const INPUT_VALUE = "input.value";
export const OUTPUT_VALUE = "output.value";
// The session grouping key (see session.ts). OpenInference's spelling, and
// the one the sink reads first; gen_ai.conversation.id is deliberately not
// emitted alongside it, one name for one fact.
export const SESSION_ID = "session.id";
// The end-user identity (see user.ts). OpenInference's spelling, also what
// Langfuse reads and what the OTel registry lists; the sink additionally
// accepts OTel's enduser.id / enduser.pseudo.id from third-party
// instrumentors, but this SDK emits one name for one fact.
export const USER_ID = "user.id";

// Process-local routing marker for multi-workspace export (see workspace.ts).
// Stamped at span start so pending snapshots route too, and ALWAYS stripped
// by the routing exporter before spans leave the process: the destination's
// API key is what tells the backend which workspace a span belongs to.
export const WORKSPACE_ROUTE = "rius.workspace";

// OTel GenAI
export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
export const GEN_AI_PROVIDER_NAME = "gen_ai.provider.name";
export const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
export const GEN_AI_REQUEST_REASONING_LEVEL = "gen_ai.request.reasoning.level";
export const GEN_AI_RESPONSE_MODEL = "gen_ai.response.model";
/**
 * Streaming, per the GenAI inference-span conventions: `gen_ai.request.stream`
 * (boolean, Conditionally Required when streaming) and
 * `gen_ai.response.time_to_first_chunk` (double, seconds, "measured from
 * request issuance", Recommended for streaming requests). Both are set by
 * `recordFirstToken`: a first chunk arriving is what proves the request
 * streamed, and the SDK has no earlier hook for it.
 */
export const GEN_AI_REQUEST_STREAM = "gen_ai.request.stream";
export const GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK = "gen_ai.response.time_to_first_chunk";
export const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
export const GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS = "gen_ai.usage.cache_read.input_tokens";
// semconv-genai renamed cache_creation -> cache_write (PR #440) before our
// cache fields first shipped; no released version carries the old name.
export const GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS = "gen_ai.usage.cache_write.input_tokens";
export const GEN_AI_USAGE_REASONING_OUTPUT_TOKENS = "gen_ai.usage.reasoning.output_tokens";
export const GEN_AI_INPUT_MESSAGES = "gen_ai.input.messages";
export const GEN_AI_OUTPUT_MESSAGES = "gen_ai.output.messages";
export const GEN_AI_RESPONSE_FINISH_REASONS = "gen_ai.response.finish_reasons";
export const GEN_AI_TOOL_NAME = "gen_ai.tool.name";
/**
 * The index, collection or knowledge base a RETRIEVER span searched. Identity,
 * set at span creation so pending snapshots carry it and so it can compose the
 * span name. Conditionally Required by the conventions when a retrieval has a
 * single identifiable data source; omitted rather than guessed otherwise.
 */
export const GEN_AI_DATA_SOURCE_ID = "gen_ai.data_source.id";
/**
 * How many documents the retriever was ASKED for, the conventions' own framing
 * ("also known as k, limit, or max_num_results"). Identity: a property of the
 * request, known before the search runs, so it rides pending snapshots.
 */
export const GEN_AI_RETRIEVAL_TOP_K = "gen_ai.retrieval.top_k";
/**
 * What the retriever RETURNED: a JSON array of objects each carrying an
 * optional `id` and an optional `score`. Identifiers and relevance, never
 * document text, which is why the conventions do not mark it sensitive and
 * why it is absent from CONTENT_ATTRIBUTES: it survives `captureContent:
 * false` the way token counts do. Retrieved text belongs in `output.value`,
 * where masking applies. Metadata rather than identity, since it cannot be
 * known while the span is still open, so it never reaches a snapshot.
 */
export const GEN_AI_RETRIEVAL_DOCUMENTS = "gen_ai.retrieval.documents";
/**
 * The request's tool/function definitions, serialized verbatim (provider
 * shapes differ; the backend reads names and sizes from either). Content,
 * not identity — listed in CONTENT_ATTRIBUTES below.
 */
export const GEN_AI_TOOL_DEFINITIONS = "gen_ai.tool.definitions";
export const GEN_AI_REQUEST_PREFIX = "gen_ai.request.";
/**
 * OTel MCP semantic conventions (semantic-conventions-genai, Development
 * stability). `mcp.method.name` is the REQUIRED attribute of an MCP client span
 * and the marker everything downstream keys on: a local TOOL span has the same
 * kind, name and I/O shape, so this is what tells the two apart.
 */
export const MCP_METHOD_NAME = "mcp.method.name";
export const MCP_METHOD_TOOLS_CALL = "tools/call";
/** The version the initialize handshake negotiated — not the one we asked for. */
export const MCP_PROTOCOL_VERSION = "mcp.protocol.version";
/**
 * OTel general `error.type`: on an MCP tools/call it is `tool_error` when the
 * result carries isError (the tool ran and reported failure), else the thrown
 * error's name when the call itself threw.
 */
export const ERROR_TYPE = "error.type";
export const ERROR_TYPE_TOOL_ERROR = "tool_error";
/**
 * Interim-round marker for a tools/call that is asking for input. NOT an OTel
 * semconv attribute, unlike the two above: the key borrows the mcp SDK's own
 * `mcp.*` spelling for its result-type field, and no convention defines it.
 * Kept as-is because the backend reads it.
 */
export const MCP_RESULT_TYPE = "mcp.result_type";
/**
 * UTF-8 byte sizes of every part of the context this SDK serialized on a
 * generation span, as one compact JSON object with readable keys:
 * `tool_definitions` (name and bytes per tool), `input_messages` /
 * `output_messages` (per message: literal role and a typed entry per part —
 * text bytes, tool_call / tool_call_response with the tool name, media by
 * type only), `cache_marker` (index of the last input message with a
 * cache_control part) and `folded` (aggregate of the input messages older
 * than the detail window). See contextSizes.ts. The backend uses it to
 * attribute `gen_ai.usage.input_tokens` across parts. A Rius vendor
 * attribute, NOT a convention (like `rius.span.pending` below: no
 * convention covers it). Computed from the normalized messages BEFORE
 * truncation, so it stays correct when the content attributes are cut at
 * the attribute cap, stripped by `captureContent: false` or rewritten by a
 * mask. Deliberately NOT in CONTENT_ATTRIBUTES (a size is not content and
 * must survive masking) and NOT in PENDING_IDENTITY_ATTRIBUTES (content is
 * unknown at span start, so a pending snapshot never carries it).
 */
export const RIUS_CONTEXT_SIZES = "rius.context.sizes";

/**
 * First streamed token/chunk arrived: the exact timestamp the backend reads
 * to derive TTFT (event time minus span start). The GenAI conventions express
 * the same signal as the derived span attribute
 * `gen_ai.response.time_to_first_chunk` (above), which `recordFirstToken`
 * emits alongside this event; the event stays because it is what the backend
 * keys on, and an absolute timestamp is not recoverable from the duration once
 * the span is stored. No convention defines an event for this.
 */
export const GEN_AI_FIRST_TOKEN_EVENT = "gen_ai.first_token";

/**
 * Observation kind. Values are OpenInference `openinference.span.kind`
 * values, the taxonomy the platform's agent analytics group by.
 */
export enum SpanKind {
  AGENT = "AGENT",
  LLM = "LLM",
  TOOL = "TOOL",
  RETRIEVER = "RETRIEVER",
  EMBEDDING = "EMBEDDING",
  CHAIN = "CHAIN",
}

/**
 * Partial on purpose. CHAIN has no GenAI operation: the conventions define
 * none for a workflow step, and inventing one would put a value on the wire
 * that no other producer agrees with. Every other kind maps to the operation
 * the conventions define for it.
 */
const OPERATION_BY_KIND: Partial<Record<SpanKind, string>> = {
  [SpanKind.LLM]: "chat",
  [SpanKind.TOOL]: "execute_tool",
  [SpanKind.EMBEDDING]: "embeddings",
  [SpanKind.AGENT]: "invoke_agent",
  [SpanKind.RETRIEVER]: "retrieval",
};

/**
 * SpanKind (our taxonomy ATTRIBUTE) -> the OpenTelemetry SpanKind FIELD, set
 * centrally at span creation. The GenAI conventions decide the field per
 * operation: inference, embeddings and retrieval call out of the process
 * (CLIENT); execute_tool is INTERNAL; invoke_agent is CLIENT only for a
 * hosted agent. Hence:
 * - LLM / EMBEDDING / RETRIEVER -> CLIENT: a remote model or index is called.
 * - TOOL -> INTERNAL: a bare TOOL span is an in-process function, and the
 *   execute-tool convention says INTERNAL. The MCP wrapper overrides this to
 *   CLIENT through `SpanOptions.otelKind` because a tools/call crosses a
 *   process boundary and the MCP client convention says CLIENT.
 * - AGENT -> INTERNAL: `observe({ kind: AGENT })` wraps an in-process agent,
 *   the convention's INTERNAL case; a hosted agent would pass `otelKind`.
 * - CHAIN -> INTERNAL: a workflow step by definition.
 * Nothing in the backend groups on this field (it reads the attributes), so
 * the mapping is free to follow the conventions exactly.
 */
const OTEL_KIND_BY_KIND: Record<SpanKind, OtelSpanKind> = {
  [SpanKind.LLM]: OtelSpanKind.CLIENT,
  [SpanKind.EMBEDDING]: OtelSpanKind.CLIENT,
  [SpanKind.RETRIEVER]: OtelSpanKind.CLIENT,
  [SpanKind.TOOL]: OtelSpanKind.INTERNAL,
  [SpanKind.AGENT]: OtelSpanKind.INTERNAL,
  [SpanKind.CHAIN]: OtelSpanKind.INTERNAL,
};

/** The OpenTelemetry `SpanKind` field a span of taxonomy `kind` should carry. */
export function otelSpanKind(kind: SpanKind): OtelSpanKind {
  return OTEL_KIND_BY_KIND[kind];
}

/**
 * Identity attributes for a span of `kind`, for setting AT CREATION.
 * Set at creation so future pending-span snapshots can classify the span.
 *
 * `name` is the span name. The GenAI execute-tool convention requires
 * `gen_ai.tool.name`, and for a local tool the span name IS the tool name,
 * so a TOOL span with a name gets it here rather than relying on every
 * caller to remember.
 */
export function kindAttributes(kind: SpanKind, name?: string): Record<string, string> {
  const attributes: Record<string, string> = { [OPENINFERENCE_SPAN_KIND]: kind };
  const operation = OPERATION_BY_KIND[kind];
  if (operation !== undefined) attributes[GEN_AI_OPERATION_NAME] = operation;
  if (kind === SpanKind.TOOL && name !== undefined) attributes[GEN_AI_TOOL_NAME] = name;
  return attributes;
}

/** Attribute keys carrying user content: masked or stripped at export. */
export const CONTENT_ATTRIBUTES: ReadonlySet<string> = new Set([
  INPUT_VALUE,
  OUTPUT_VALUE,
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  // Sensitive per the GenAI conventions (semconv-genai#431): tool definitions
  // routinely embed proprietary prompt engineering, and sometimes credentials
  // or internal URLs in parameter defaults. gen_ai.tool.name stays: it is
  // identity, not content.
  "gen_ai.tool.description",
  GEN_AI_TOOL_DEFINITIONS,
  // GenAI semconv keys emitted by OTel-native instrumentations (@ai-sdk/otel,
  // which init() registers for ai v7, among them; pinned 2026-09-14): the
  // system prompt and each tool call's input and output are content in the
  // same sense messages are. gen_ai.tool.call.id stays: identity.
  "gen_ai.system_instructions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  // OpenInference TOOL-kind spans carry the definition under these two bare
  // keys, sensitive for the reason gen_ai.tool.description is.
  "tool.description",
  "tool.parameters",
  "gen_ai.prompt",
  "gen_ai.completion",
  "llm.input_messages",
  "llm.output_messages",
  // The prefix list below covers the flattened "llm.prompts." and
  // "llm.prompt_template." forms, but an instrumentation may emit either as a
  // single unflattened array attribute under the bare key, which no prefix
  // matches. Both bare keys are therefore listed here as well.
  "llm.prompts",
  "llm.prompt_template",
  "mlflow.spanInputs",
  "mlflow.spanOutputs",
  "traceloop.entity.input",
  "traceloop.entity.output",
  // Every bundled OpenInference instrumentation emits tool definitions as
  // llm.tools.{i}.tool.json_schema (pinned empirically 2026-09-14); covered
  // by prefix below, bare key listed per the bare-key rule.
  "llm.tools",
  // The Vercel AI SDK's own telemetry keys survive the OpenInference
  // transform untouched, and they carry the full prompt (messages AND tool
  // definitions), response content, and tool-call I/O. Names, ids and models
  // (ai.toolCall.name, ai.response.model, ...) are identity and stay.
  "ai.prompt",
  "ai.response.text",
  "ai.response.object",
  "ai.toolCall.args",
  "ai.toolCall.result",
  // Same family, keys enumerated from the ai v7 telemetry surface
  // (2026-09-14): model reasoning, tool calls in the response, response
  // files, embedding inputs, rerank documents, and the generateObject schema
  // (a tool definition by another name).
  "ai.response.reasoning",
  "ai.response.toolCalls",
  "ai.response.files",
  "ai.value",
  "ai.values",
  "ai.documents",
  "ai.schema",
  "ai.schema.description",
]);

// The request-parameters bag OpenInference instrumentations emit. Not wholly
// content — sampling parameters are identity — but the litellm (Python) and
// langchain instrumentations embed the request's tools/functions arrays
// inside it, so masking redacts those members and keeps the rest (masking.ts).
export const LLM_INVOCATION_PARAMETERS = "llm.invocation_parameters";
/** JSON members of LLM_INVOCATION_PARAMETERS that carry tool definitions. */
export const INVOCATION_PARAMETERS_CONTENT_MEMBERS: readonly string[] = ["tools", "functions"];

export const CONTENT_ATTRIBUTE_PREFIXES: readonly string[] = [
  "llm.input_messages.",
  "llm.output_messages.",
  "gen_ai.prompt.",
  "gen_ai.completion.",
  "llm.prompts.",
  "llm.prompt_template.",
  "llm.tools.",
  "ai.prompt.",
];

export const CONTENT_ATTRIBUTE_SUFFIXES: readonly string[] = [
  ".document.content",
  ".embedding.text",
];

// --- Pending (partial) spans ---
// Marks the content-free snapshot exported at span START; the backend maps it
// to Finished=0 and the real span replaces it at end. This key knowingly bends
// the convention-native rule (no vendor namespace): OpenTelemetry has NO
// pending-span mechanism to align with (spec #3732/#4646, semconv #2133, all
// open, none planned), and the only shipping precedent (Logfire's
// logfire.span_type) is equally vendor-namespaced. Spelled glassflow.span.pending
// before the vendor keys moved under rius.*; the backend reads both spellings
// for as long as pre-rename SDK versions are in the field.
export const RIUS_SPAN_PENDING = "rius.span.pending";

// Attributes allowed to ride a pending snapshot: identity/taxonomy known at
// span start. An ALLOWLIST on purpose: content exclusion must hold for
// third-party instrumentors' attribute families too, and a blocklist would
// have to enumerate all of them.
export const PENDING_IDENTITY_ATTRIBUTES: ReadonlySet<string> = new Set([
  OPENINFERENCE_SPAN_KIND,
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_TOOL_NAME,
  // The retrieval target is identity in the same sense the tool name is: a
  // still-running retrieval must be attributable to the index it is hitting.
  GEN_AI_DATA_SOURCE_ID,
  // Equally a property of the request, so equally knowable at start. Its
  // counterpart GEN_AI_RETRIEVAL_DOCUMENTS is deliberately absent: what came
  // back cannot be known while the span is open.
  GEN_AI_RETRIEVAL_TOP_K,
  // Protocol identity, not content: a still-running MCP call must be
  // distinguishable from a local tool in the live view — the one place
  // setting the marker at creation pays off.
  MCP_METHOD_NAME,
  MCP_PROTOCOL_VERSION,
  // Identity, not content: a pending span must be groupable into its
  // session while still running, that is the live view's whole point.
  SESSION_ID,
  // Same reason: a crashed run's partial spans must still be attributable
  // to the user they served.
  USER_ID,
  // Routing, not content: a crashed run's snapshot must land in the same
  // workspace its final span would have. Stripped at export either way.
  WORKSPACE_ROUTE,
]);

// gen_ai.request.* (model, temperature, ...) is identity, not content.
export const PENDING_IDENTITY_PREFIXES: readonly string[] = [GEN_AI_REQUEST_PREFIX];
