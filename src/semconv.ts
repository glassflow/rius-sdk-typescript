/** Wire-visible instrumentation scope name. The backend keys on this value. */
export const TRACER_NAME = "glassflow";

// OpenInference
export const OPENINFERENCE_SPAN_KIND = "openinference.span.kind";
export const INPUT_VALUE = "input.value";
export const OUTPUT_VALUE = "output.value";

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
  // Deliberate addition over Python (2026-08-12): the prefix list covers
  // "llm.prompts." and "llm.prompt_template." but neither bare key was in
  // either SDK's exact set, so an instrumentation emitting one unflattened
  // array attribute leaked past captureContent: false. Python has the same
  // gap and needs the same fix; this SDK does not wait for it.
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
