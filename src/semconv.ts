import { type Attributes, SpanKind as OtelSpanKind } from "@opentelemetry/api";
import { ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

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
 * The provider's identifier for the completion (`chatcmpl-123` and the like),
 * Recommended on an inference span. METADATA, not identity: it arrives with
 * the response, so it cannot be known when the span is created and never
 * rides a pending snapshot. Not content either — an opaque provider id
 * carries nothing the model was shown — so it survives
 * `captureContent: false` and is absent from CONTENT_ATTRIBUTES.
 */
export const GEN_AI_RESPONSE_ID = "gen_ai.response.id";
/**
 * The output modality the client ASKED the model for: the conventions define
 * `text`, `json`, `image` and `speech`, and mark it Conditionally Required
 * "when applicable and if the request includes an output format". A property
 * of the REQUEST, so IDENTITY: known before the call is made, set at span
 * creation, and allowlisted onto pending snapshots below — the key does not
 * live under `gen_ai.request.`, so PENDING_IDENTITY_PREFIXES does not cover
 * it and it needs its own entry. Not content: a modality is not what was
 * said. The caller's string is recorded verbatim rather than checked against
 * the four members; the registry's enum is open, and a value we do not
 * recognise is still what the caller requested.
 */
export const GEN_AI_OUTPUT_TYPE = "gen_ai.output.type";
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
/**
 * The model sampling parameters, the `gen_ai.request.*` family the conventions
 * define. Two routes produce them: a generation's `modelParameters`, through
 * {@link GEN_AI_REQUEST_PARAMETERS}, and normalization, which promotes them
 * out of a third-party request bag.
 */
export const GEN_AI_REQUEST_TEMPERATURE = "gen_ai.request.temperature";
export const GEN_AI_REQUEST_TOP_P = "gen_ai.request.top_p";
export const GEN_AI_REQUEST_TOP_K = "gen_ai.request.top_k";
export const GEN_AI_REQUEST_MAX_TOKENS = "gen_ai.request.max_tokens";
export const GEN_AI_REQUEST_FREQUENCY_PENALTY = "gen_ai.request.frequency_penalty";
export const GEN_AI_REQUEST_PRESENCE_PENALTY = "gen_ai.request.presence_penalty";
export const GEN_AI_REQUEST_SEED = "gen_ai.request.seed";
export const GEN_AI_REQUEST_STOP_SEQUENCES = "gen_ai.request.stop_sequences";
export const GEN_AI_REQUEST_CHOICE_COUNT = "gen_ai.request.choice.count";
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
 * The identifier of the model's tool-call message this execution answers,
 * Recommended "if available" on an execute-tool span. It is what joins a tool
 * span back to the assistant turn that asked for it. IDENTITY: the caller has
 * it before the tool runs, so it is set at span creation and rides pending
 * snapshots — a still-running tool must be joinable to its call. Not content:
 * an opaque provider id, unlike `gen_ai.tool.call.arguments`, which IS
 * content and is listed below. Never derived: only the caller knows it.
 */
export const GEN_AI_TOOL_CALL_ID = "gen_ai.tool.call.id";
/**
 * What kind of tool ran — the conventions' own examples are `function` (the
 * client executes the logic), `extension` (the agent calls an external API)
 * and `datastore` (a retrieval-style lookup). Recommended "if available", and
 * sampling-relevant, which is why it is IDENTITY here: set at creation so it
 * reaches pending snapshots and any future sampler. Not content. Recorded
 * verbatim, like the output type: the value set is open and a caller's own
 * vocabulary is still the truth about their tool.
 */
export const GEN_AI_TOOL_TYPE = "gen_ai.tool.type";
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
 * The agent this process is. Stamped on the RESOURCE, once per client, from
 * the configured agent name. The backend derives a span's agent from the
 * resource first and falls back to `service.name`, so a process whose agent
 * name and service name are equal is unchanged on the wire, and one where
 * they differ stops having its spans and its heartbeats grouped under two
 * different values.
 */
export const GEN_AI_AGENT_NAME = "gen_ai.agent.name";
/**
 * The identifier of a HOSTED agent resource, not of an agent in general: the
 * conventions give an AWS Bedrock agent ARN and a GCP Agent Registry id as the
 * examples, and say it is NOT RECOMMENDED to record in-memory agent instance
 * ids here, because those are transient. So an in-process agent leaves it
 * unset and there is no configured default to fall back to — a name is the
 * only identity such an agent has.
 */
export const GEN_AI_AGENT_ID = "gen_ai.agent.id";

/**
 * The deployment's build version, an OTel RESOURCE attribute rather than a
 * GenAI one. Re-exported as an alias of OpenTelemetry's own constant rather
 * than restated as a literal: the value is theirs to define, and aliasing
 * keeps us pinned to it. Exported at all so the parity fixture can police it,
 * since the Python SDK names the same key in its semconv.
 *
 * Not to be confused with the two agent versions. This is which BUILD is
 * running; `rius.main_agent.version` is which version of the agent DEFINITION
 * the process runs, and `gen_ai.agent.version` is the version of an agent a
 * span invoked.
 */
export const SERVICE_VERSION = ATTR_SERVICE_VERSION;
/**
 * The request's tool/function definitions, serialized verbatim (provider
 * shapes differ; the backend reads names and sizes from either). Content,
 * not identity — listed in CONTENT_ATTRIBUTES below.
 */
/**
 * The version of the agent an AGENT span INVOKES, per the GenAI registry
 * (`gen_ai.agent.version`, string, examples `1.0.0` and `2025-05-01`). It
 * describes the same callee `gen_ai.agent.name` and `gen_ai.agent.id` do, so
 * it is set only on AGENT spans and only from the caller's own string, taken
 * verbatim: the registry's examples are semver and a date, so there is no
 * format to validate against.
 *
 * Deliberately NOT derived from `service.version` or from
 * `rius.main_agent.version`. A service at 2.3.1 may invoke an agent whose
 * prompt, tools and policy are at 7, and a process may invoke several agents
 * at different versions; deriving one from another would answer a question
 * nobody asked with a number nobody set.
 *
 * Identity, so it is set at span CREATION and allowlisted onto pending
 * snapshots below — which agent version a still-running span invoked is
 * exactly what a live view needs.
 */
export const GEN_AI_AGENT_VERSION = "gen_ai.agent.version";
/**
 * The agent THIS PROCESS IS, in our own namespace, stamped on the RESOURCE.
 *
 * `gen_ai.agent.name` has no resource-level meaning in the conventions, and on
 * a span it means the agent being INVOKED, so using it for both made one key
 * carry two questions. These keys ask only the process-level one. The value is
 * the SAME resolved agent name `gen_ai.agent.name` carries, with the same
 * placeholder suppression — this is a move into our namespace, not a second
 * identity to configure.
 *
 * `gen_ai.agent.name` keeps being stamped alongside them. Dropping it would be
 * a flag day: every deployment between this SDK release and the sink release
 * would lose its agent identity. Resource attributes ride once per OTLP batch,
 * not once per span, so the duplication is free.
 */
export const RIUS_MAIN_AGENT_NAME = "rius.main_agent.name";
/**
 * A STABLE identifier for the agent this process is, such as a registry id or
 * a hosted agent's ARN. The upstream constraint on `gen_ai.agent.id` is
 * adopted here deliberately, even though we own this namespace: a transient
 * in-memory or process-local id (a uuid minted at startup, an object address,
 * a pod name) must NOT be used, because it identifies a run rather than an
 * agent and would shatter every agent into one bucket per restart.
 * `service.instance.id` already answers "which process"; this answers "which
 * agent". Keeping the constraint now is what makes a later rename to
 * `gen_ai.main_agent.*` mechanical rather than a data-quality problem.
 *
 * Unset by default and never defaulted: unlike the name, it has no service-
 * level value to fall back on, and inventing one would be the `unknown_service`
 * mistake again.
 */
export const RIUS_MAIN_AGENT_ID = "rius.main_agent.id";
/** A human-readable description of the agent this process is. Never defaulted. */
export const RIUS_MAIN_AGENT_DESCRIPTION = "rius.main_agent.description";
/**
 * The version of the AGENT DEFINITION this process runs — its prompt, tools
 * and policy — NOT of the build that hosts it. That is `service.version`, and
 * the two move independently: a service can sit at 2.3.1 while the agent it
 * runs is at 7, and a prompt change ships an agent version without touching
 * the build. Neither is ever derived from the other, in either direction.
 * Never defaulted, for the reason the id is not.
 */
export const RIUS_MAIN_AGENT_VERSION = "rius.main_agent.version";
export const GEN_AI_TOOL_DEFINITIONS = "gen_ai.tool.definitions";
export const GEN_AI_REQUEST_PREFIX = "gen_ai.request.";
/**
 * Where a request parameter the GenAI registry does NOT define goes. Our own
 * namespace rather than `gen_ai.request.<key>`, per OTel's naming guidance: an
 * existing semantic-convention namespace must not be used as a prefix for
 * application-specific attributes, because the convention is free to define
 * that exact key later and mean something else. The GenAI conventions offer
 * no catch-all of their own, so we own one.
 *
 * Masking: `rius.request.*` follows `gen_ai.request.*` exactly. Neither is in
 * CONTENT_ATTRIBUTES wholesale, so both export in clear. The TIE is the rule,
 * not the current value: if request parameters ever become maskable, both
 * namespaces change together, and neither may join the content allowlist
 * alone. A semconv test pins it.
 */
export const RIUS_REQUEST_PREFIX = "rius.request.";

/**
 * Request parameters the GenAI conventions define, mapped from every spelling
 * we recognise to the canonical attribute key. Verified against
 * open-telemetry/semantic-conventions-genai at commit
 * 8ffdf568e1b4391a99adb081db16e8102e36918e (2026-09-22),
 * model/gen-ai/registry.yaml; the repo cuts no releases, so a commit is the
 * only citable pin. Each canonical key appears under its own bare spelling
 * plus the provider spellings that mean the SAME parameter; anything absent
 * here is a caller parameter and goes to {@link RIUS_REQUEST_PREFIX} verbatim.
 *
 * A provider spelling normalises to ONE key, the canonical one: the provider
 * spelling is not also emitted. Two keys for one parameter would make every
 * consumer de-duplicate, and the point of a convention is that there is one
 * place to look.
 *
 * Kept identical to the Python SDK's table of the same name; a parity fixture
 * runs every spelling through both.
 */
export const GEN_AI_REQUEST_PARAMETERS: Readonly<Record<string, string>> = {
  // model: the request's model; also settable via the `model` option.
  model: GEN_AI_REQUEST_MODEL,
  // max_tokens: OpenAI Chat Completions `max_tokens`, its successor
  // `max_completion_tokens`, the Responses API's `max_output_tokens`, and
  // Google's `maxOutputTokens`.
  max_tokens: GEN_AI_REQUEST_MAX_TOKENS,
  maxTokens: GEN_AI_REQUEST_MAX_TOKENS,
  max_completion_tokens: GEN_AI_REQUEST_MAX_TOKENS,
  maxCompletionTokens: GEN_AI_REQUEST_MAX_TOKENS,
  max_output_tokens: GEN_AI_REQUEST_MAX_TOKENS,
  maxOutputTokens: GEN_AI_REQUEST_MAX_TOKENS,
  // choice.count: "the target number of candidate completions to return":
  // OpenAI `n`, Google `candidateCount`, Cohere `num_generations`.
  "choice.count": GEN_AI_REQUEST_CHOICE_COUNT,
  n: GEN_AI_REQUEST_CHOICE_COUNT,
  candidate_count: GEN_AI_REQUEST_CHOICE_COUNT,
  candidateCount: GEN_AI_REQUEST_CHOICE_COUNT,
  num_generations: GEN_AI_REQUEST_CHOICE_COUNT,
  temperature: GEN_AI_REQUEST_TEMPERATURE,
  // top_p: Google `topP`, Cohere `p`.
  top_p: GEN_AI_REQUEST_TOP_P,
  topP: GEN_AI_REQUEST_TOP_P,
  p: GEN_AI_REQUEST_TOP_P,
  // top_k: the registry's own note names Anthropic `top_k`, Cohere `k` and
  // Google `topK`, and says OpenAI's `top_logprobs` MUST NOT be reported here
  // (it shapes the response, not the sampling). So top_logprobs is
  // deliberately absent and lands in rius.request.*.
  top_k: GEN_AI_REQUEST_TOP_K,
  topK: GEN_AI_REQUEST_TOP_K,
  k: GEN_AI_REQUEST_TOP_K,
  // stop_sequences: OpenAI `stop`, Google `stopSequences`.
  stop_sequences: GEN_AI_REQUEST_STOP_SEQUENCES,
  stopSequences: GEN_AI_REQUEST_STOP_SEQUENCES,
  stop: GEN_AI_REQUEST_STOP_SEQUENCES,
  frequency_penalty: GEN_AI_REQUEST_FREQUENCY_PENALTY,
  frequencyPenalty: GEN_AI_REQUEST_FREQUENCY_PENALTY,
  presence_penalty: GEN_AI_REQUEST_PRESENCE_PENALTY,
  presencePenalty: GEN_AI_REQUEST_PRESENCE_PENALTY,
  // encoding_formats: plural in the registry; OpenAI's embeddings endpoint
  // sends the singular `encoding_format`, and the registry's note says some
  // systems call these "embedding types" (Cohere `embedding_types`).
  encoding_formats: "gen_ai.request.encoding_formats",
  encoding_format: "gen_ai.request.encoding_formats",
  encodingFormat: "gen_ai.request.encoding_formats",
  embedding_types: "gen_ai.request.encoding_formats",
  seed: GEN_AI_REQUEST_SEED,
  stream: GEN_AI_REQUEST_STREAM,
  // reasoning.level: "the exact string value sent to the provider"; OpenAI
  // sends it as `reasoning_effort`.
  "reasoning.level": GEN_AI_REQUEST_REASONING_LEVEL,
  reasoning_level: GEN_AI_REQUEST_REASONING_LEVEL,
  reasoning_effort: GEN_AI_REQUEST_REASONING_LEVEL,
  reasoningEffort: GEN_AI_REQUEST_REASONING_LEVEL,
  // previous_response.id: the registry names OpenAI's `previous_response_id`
  // and Google's `previous_interaction_id`.
  "previous_response.id": "gen_ai.request.previous_response.id",
  previous_response_id: "gen_ai.request.previous_response.id",
  previousResponseId: "gen_ai.request.previous_response.id",
  previous_interaction_id: "gen_ai.request.previous_response.id",
  // stream_cursor: the registry names OpenAI's `starting_after` and Google's
  // `last_event_id`.
  stream_cursor: "gen_ai.request.stream_cursor",
  starting_after: "gen_ai.request.stream_cursor",
  last_event_id: "gen_ai.request.stream_cursor",
};

/**
 * The attribute key one caller-supplied request parameter is recorded under.
 *
 * A parameter the GenAI conventions define, under its canonical name or a
 * recognised provider spelling, normalises to its canonical
 * `gen_ai.request.*` key. Everything else keeps its key verbatim under
 * `rius.request.`. An own-property lookup, so `constructor` or `__proto__`
 * is a caller parameter like any other rather than a match found on the
 * prototype chain.
 */
export function requestAttributeKey(parameter: string): string {
  return Object.hasOwn(GEN_AI_REQUEST_PARAMETERS, parameter)
    ? GEN_AI_REQUEST_PARAMETERS[parameter]
    : `${RIUS_REQUEST_PREFIX}${parameter}`;
}
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
 * The OTel exception event, as `recordException()` writes it, and its attribute
 * naming the exception's class. Read, never emitted by us directly: an
 * auto-instrumented failure carries these but no `error.type`, so normalization
 * derives `error.type` from `EXCEPTION_TYPE` (see normalize.ts).
 */
export const EXCEPTION_EVENT = "exception";
export const EXCEPTION_TYPE = "exception.type";
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
 * The inverse, for spans that speak only the conventions. A GenAI-native
 * instrumentation sets `gen_ai.operation.name` and has never heard of
 * `openinference.span.kind`, and the contract requires both keys on every
 * span, so the derivation has to run in both directions.
 *
 * NOT a mechanical inversion of the map above, and it cannot be generated
 * from it, for two reasons:
 * - Several operations share one kind. `text_completion` and
 *   `generate_content` are LLM calls the same way `chat` is, and
 *   `create_agent` is an AGENT span just as `invoke_agent` is, so the mapping
 *   is many-to-one and only the chat / invoke_agent entries round-trip.
 * - CHAIN has no operation of its own, but two operations land on it.
 *   `invoke_workflow` and `plan` are real GenAI operations with no taxonomy
 *   value, CHAIN is the honest home for both, and this direction is the only
 *   one that can say so.
 *
 * A test asserts the round-trip where an operation exists, not equality of
 * the two maps: asserting inverses would force one of those four extra
 * operations to be dropped. Mirrors the console's deriveSpanKind.
 */
const KIND_BY_OPERATION: Record<string, SpanKind> = {
  chat: SpanKind.LLM,
  text_completion: SpanKind.LLM,
  generate_content: SpanKind.LLM,
  execute_tool: SpanKind.TOOL,
  embeddings: SpanKind.EMBEDDING,
  invoke_agent: SpanKind.AGENT,
  create_agent: SpanKind.AGENT,
  retrieval: SpanKind.RETRIEVER,
  invoke_workflow: SpanKind.CHAIN,
  plan: SpanKind.CHAIN,
};

/**
 * The `gen_ai.operation.name` a taxonomy value implies, or `undefined` when
 * it has none.
 *
 * Takes the raw attribute string rather than the enum, because the caller is
 * normalizing a third-party span where the value is whatever the
 * instrumentation wrote — OpenInference's own taxonomy has RERANKER,
 * GUARDRAIL, EVALUATOR and PROMPT, none of which we model. An unrecognised
 * value yields `undefined` rather than throwing: a span carrying a kind we do
 * not know is not a reason to lose the span.
 */
export function operationForKind(kind: string): string | undefined {
  // hasOwn, not a bare lookup: the value comes from another producer's span,
  // and "constructor" would otherwise resolve through the prototype.
  return Object.hasOwn(OPERATION_BY_KIND, kind) ? OPERATION_BY_KIND[kind as SpanKind] : undefined;
}

/** The taxonomy value a `gen_ai.operation.name` implies, or `undefined`. */
export function kindForOperation(operation: string): string | undefined {
  return Object.hasOwn(KIND_BY_OPERATION, operation) ? KIND_BY_OPERATION[operation] : undefined;
}

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
 * `toolName` is the tool name a TOOL span carries as `gen_ai.tool.name`,
 * Required by the GenAI execute-tool convention. It is taken as its own
 * input rather than read off the span name: once span names follow the
 * `{operation} {target}` convention the two are different strings, so one
 * input cannot serve both. Callers that have no separate tool name pass the
 * span name, which is what they meant before.
 */
export function kindAttributes(kind: SpanKind, toolName?: string): Record<string, string> {
  const attributes: Record<string, string> = { [OPENINFERENCE_SPAN_KIND]: kind };
  const operation = OPERATION_BY_KIND[kind];
  if (operation !== undefined) attributes[GEN_AI_OPERATION_NAME] = operation;
  if (kind === SpanKind.TOOL && toolName !== undefined) attributes[GEN_AI_TOOL_NAME] = toolName;
  return attributes;
}

/**
 * The attribute whose value completes a span's name, per kind. The GenAI
 * conventions name a span `{operation} {target}`, and each operation has its
 * own target: the model for inference and embeddings, the tool, the agent,
 * the data source. CHAIN is absent because it has no operation to compose
 * with, and LLM reads the REQUEST model on purpose — the response model can
 * arrive long after the span was named, and a pending snapshot must carry the
 * same name as the final span.
 */
const NAME_TARGET_BY_KIND: Partial<Record<SpanKind, string>> = {
  [SpanKind.LLM]: GEN_AI_REQUEST_MODEL,
  [SpanKind.EMBEDDING]: GEN_AI_REQUEST_MODEL,
  [SpanKind.TOOL]: GEN_AI_TOOL_NAME,
  [SpanKind.AGENT]: GEN_AI_AGENT_NAME,
  [SpanKind.RETRIEVER]: GEN_AI_DATA_SOURCE_ID,
};

/**
 * The name a CHAIN span falls back to when the caller named neither it nor
 * the function behind it. The one degenerate case: a CHAIN has no operation
 * and no target, so there is nothing to compose from, and an empty span name
 * is worse than a vague one.
 *
 * Exported because the Python SDK defines the same literal and the parity
 * fixture keeps the two in lockstep; a CHAIN span must be named identically
 * whichever SDK produced it.
 */
export const CHAIN_SPAN_NAME = "chain";

/**
 * The conventions' span name for a span that will carry `attributes`:
 * `{operation} {target}`, e.g. `chat gpt-4o`, `execute_tool get_weather`,
 * falling back to the bare operation when the target is unknown.
 *
 * Composed from the attributes the span is actually being created with, not
 * from the caller's options, so the name can never disagree with the span it
 * names: the operation is whatever `gen_ai.operation.name` ended up being
 * (a generation may override it to `embeddings`), and the target is the
 * resolved value (a tool name defaulted from the span name, an agent name
 * fallen back to the configured one). It only READS them, so the rendered
 * name never contaminates the attribute it was built from.
 */
export function composeSpanName(kind: SpanKind, attributes: Attributes): string {
  const operation = attributes[GEN_AI_OPERATION_NAME];
  if (typeof operation !== "string") return CHAIN_SPAN_NAME;
  const targetKey = NAME_TARGET_BY_KIND[kind];
  const target = targetKey === undefined ? undefined : attributes[targetKey];
  return typeof target === "string" && target !== "" ? `${operation} ${target}` : operation;
}

// OpenInference's flattened message families, read by normalization and
// reassembled into GEN_AI_INPUT_MESSAGES / GEN_AI_OUTPUT_MESSAGES: one key per
// field, `<prefix><i>.message.role`, `...message.tool_calls.<j>.tool_call.id`,
// `...message.contents.<k>.message_content.type` and so on. Source spellings,
// never emitted; the Python SDK keeps the same strings in normalization.py.
export const LLM_INPUT_MESSAGES_PREFIX = "llm.input_messages.";
export const LLM_OUTPUT_MESSAGES_PREFIX = "llm.output_messages.";
/** The message fields read, relative to `<prefix><i>.`. */
export const LLM_MESSAGE_ROLE = "message.role";
export const LLM_MESSAGE_CONTENT = "message.content";
export const LLM_MESSAGE_TOOL_CALL_ID = "message.tool_call_id";
/** A message's tool calls: `message.tool_calls.<j>.tool_call.<field>`. */
export const LLM_MESSAGE_TOOL_CALLS_PREFIX = "message.tool_calls.";
export const LLM_TOOL_CALL_PREFIX = "tool_call.";
/** Tool-call fields relative to `tool_call.`. */
export const LLM_TOOL_CALL_ID = "id";
export const LLM_TOOL_CALL_FUNCTION_NAME = "function.name";
export const LLM_TOOL_CALL_FUNCTION_ARGUMENTS = "function.arguments";
/**
 * A message's multimodal items: `message.contents.<k>.message_content.<field>`,
 * plus `message.contents.<k>.tool_call.<field>` on a tool_use item.
 */
export const LLM_MESSAGE_CONTENTS_PREFIX = "message.contents.";
export const LLM_MESSAGE_CONTENT_PREFIX = "message_content.";

// The request-parameters bag OpenInference instrumentations emit. Not wholly
// content — sampling parameters are identity — but the litellm (Python) and
// langchain instrumentations embed the request's tools/functions arrays
// inside it, so masking redacts those members and keeps the rest (masking.ts).
export const LLM_INVOCATION_PARAMETERS = "llm.invocation_parameters";
/**
 * Parameter names that carry TOOL DEFINITIONS rather than a sampling knob.
 * Named once and consumed by every route to the same definitions, so the
 * routes cannot drift apart:
 *   - as JSON members of LLM_INVOCATION_PARAMETERS, redacted member by member
 *     (masking.ts), and
 *   - as `gen_ai.request.<member>` and `rius.request.<member>`, when a caller
 *     passes `tools` through `modelParameters` and it reaches either
 *     namespace (derived into CONTENT_ATTRIBUTES below).
 * Tool definitions are content in the same sense messages are (see
 * GEN_AI_TOOL_DEFINITIONS), and which route they arrived by cannot be what
 * decides whether they are protected.
 */
export const INVOCATION_PARAMETERS_CONTENT_MEMBERS: readonly string[] = ["tools", "functions"];

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
  // The NAMED EXCEPTION to the rule that request parameters export in clear.
  // That rule is right for scalar knobs (temperature, top_p, seed), but a
  // parameter bag is not typed: a caller passing modelParameters: { tools }
  // would otherwise export proprietary prompt engineering verbatim with
  // captureContent: false explicitly set, while the very same array is
  // stripped when it arrives as gen_ai.tool.definitions or inside
  // llm.invocation_parameters. Per KEY, not per namespace: both namespaces
  // stay non-content wholesale, which is what keeps their tie intact.
  ...[GEN_AI_REQUEST_PREFIX, RIUS_REQUEST_PREFIX].flatMap((prefix) =>
    INVOCATION_PARAMETERS_CONTENT_MEMBERS.map((member) => `${prefix}${member}`),
  ),
]);

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
  // The two other halves of a tool call's identity, both caller-supplied at
  // creation: which model tool-call this execution answers, and what kind of
  // tool it is. A tool that hangs is exactly the span a live view needs to
  // show attached to its call, so both must survive the snapshot.
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_TYPE,
  // A property of the request, like the model parameters the prefix rule
  // covers — but spelled outside `gen_ai.request.`, so it needs its own
  // entry here or it would be silently dropped from every snapshot.
  GEN_AI_OUTPUT_TYPE,
  // The retrieval target is identity in the same sense the tool name is: a
  // still-running retrieval must be attributable to the index it is hitting.
  GEN_AI_DATA_SOURCE_ID,
  // Equally a property of the request, so equally knowable at start. Its
  // counterpart GEN_AI_RETRIEVAL_DOCUMENTS is deliberately absent: what came
  // back cannot be known while the span is open.
  GEN_AI_RETRIEVAL_TOP_K,
  // Which agent a span invokes is chosen before the work starts, so a
  // still-running agent is attributable in the live view. Distinct from the
  // RESOURCE key of the same name, which says which PROCESS is running; these
  // say which agent that process invoked here.
  GEN_AI_AGENT_NAME,
  GEN_AI_AGENT_ID,
  // Same callee, same reason: the version of the agent being invoked is
  // chosen before the work starts, so a still-running agent span can say
  // which version of it is running.
  GEN_AI_AGENT_VERSION,
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

// gen_ai.request.* (model, temperature, ...) is identity, not content, and so
// is rius.request.* (the caller parameters the conventions do not define):
// both are chosen before the call runs, so a live view of a still-running
// generation must already show them. The two namespaces are deliberately
// treated alike here as well as in CONTENT_ATTRIBUTES. The tool-definition
// members ride a snapshot by prefix too, and are stripped from it at export
// like every other content key.
export const PENDING_IDENTITY_PREFIXES: readonly string[] = [
  GEN_AI_REQUEST_PREFIX,
  RIUS_REQUEST_PREFIX,
];
