/** Wire-visible instrumentation scope name. The backend keys on this value. */
export const TRACER_NAME = "glassflow";

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

// OTel GenAI
export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
export const GEN_AI_PROVIDER_NAME = "gen_ai.provider.name";
export const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
export const GEN_AI_RESPONSE_MODEL = "gen_ai.response.model";
export const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
export const GEN_AI_INPUT_MESSAGES = "gen_ai.input.messages";
export const GEN_AI_OUTPUT_MESSAGES = "gen_ai.output.messages";
export const GEN_AI_RESPONSE_FINISH_REASONS = "gen_ai.response.finish_reasons";
export const GEN_AI_TOOL_NAME = "gen_ai.tool.name";
export const GEN_AI_REQUEST_PREFIX = "gen_ai.request.";
export const MCP_RESULT_TYPE = "mcp.result_type";

/** First streamed token arrived: the TTFT anchor. */
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

const OPERATION_BY_KIND: Partial<Record<SpanKind, string>> = {
  [SpanKind.LLM]: "chat",
  [SpanKind.TOOL]: "execute_tool",
  [SpanKind.EMBEDDING]: "embeddings",
  [SpanKind.AGENT]: "invoke_agent",
};

/**
 * Identity attributes for a span of `kind`, for setting AT CREATION.
 * Set at creation so future pending-span snapshots can classify the span.
 */
export function kindAttributes(kind: SpanKind): Record<string, string> {
  const attributes: Record<string, string> = { [OPENINFERENCE_SPAN_KIND]: kind };
  const operation = OPERATION_BY_KIND[kind];
  if (operation !== undefined) attributes[GEN_AI_OPERATION_NAME] = operation;
  return attributes;
}

/** Attribute keys carrying user content: masked or stripped at export. */
export const CONTENT_ATTRIBUTES: ReadonlySet<string> = new Set([
  INPUT_VALUE,
  OUTPUT_VALUE,
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
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
]);

export const CONTENT_ATTRIBUTE_PREFIXES: readonly string[] = [
  "llm.input_messages.",
  "llm.output_messages.",
  "gen_ai.prompt.",
  "gen_ai.completion.",
  "llm.prompts.",
  "llm.prompt_template.",
];

export const CONTENT_ATTRIBUTE_SUFFIXES: readonly string[] = [
  ".document.content",
  ".embedding.text",
];

// --- Pending (partial) spans ---
// Marks the content-free snapshot exported at span START; the backend maps it
// to Finished=0 and the real span replaces it at end. This key knowingly bends
// the convention-native rule (no glassflow.* namespace): OpenTelemetry has NO
// pending-span mechanism to align with (spec #3732/#4646, semconv #2133, all
// open, none planned), and the only shipping precedent (Logfire's
// logfire.span_type) is equally vendor-namespaced.
export const GLASSFLOW_SPAN_PENDING = "glassflow.span.pending";

// Attributes allowed to ride a pending snapshot: identity/taxonomy known at
// span start. An ALLOWLIST on purpose: content exclusion must hold for
// third-party instrumentors' attribute families too, and a blocklist would
// have to enumerate all of them.
export const PENDING_IDENTITY_ATTRIBUTES: ReadonlySet<string> = new Set([
  OPENINFERENCE_SPAN_KIND,
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_TOOL_NAME,
  // Identity, not content: a pending span must be groupable into its
  // session while still running, that is the live view's whole point.
  SESSION_ID,
]);

// gen_ai.request.* (model, temperature, ...) is identity, not content.
export const PENDING_IDENTITY_PREFIXES: readonly string[] = [GEN_AI_REQUEST_PREFIX];
