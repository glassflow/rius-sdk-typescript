import { getTracer } from "./client.js";
import { serializeMessages } from "./messages.js";
import {
  GEN_AI_FIRST_TOKEN_EVENT,
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OPERATION_NAME,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_REQUEST_PREFIX,
  GEN_AI_REQUEST_REASONING_LEVEL,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_TOOL_DEFINITIONS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  SpanKind,
  USER_ID,
  kindAttributes,
} from "./semconv.js";
import { toAttributeValue } from "./serde.js";
import { Observation, runActive } from "./spans.js";

/**
 * Options for {@link startGeneration} and {@link startAsCurrentGeneration}:
 * the model identity and request parameters an LLM span carries.
 */
export interface GenerationOptions {
  model?: string;
  provider?: string;
  input?: unknown;
  /**
   * Request parameters, each recorded as `gen_ai.request.<key>` — for example
   * `{ temperature: 0.2, max_tokens: 512 }`. Keys are passed through verbatim,
   * so use the provider's own parameter names.
   */
  modelParameters?: Record<string, unknown>;
  /**
   * Requested reasoning/thinking effort level
   * (`gen_ai.request.reasoning.level`), e.g. OpenAI's `reasoning.effort`
   * values. Provider-defined string, recorded verbatim. A first-class option
   * because the `modelParameters` pass-through would spell the key
   * `gen_ai.request.reasoning_level`, which is not the convention's name.
   */
  reasoningLevel?: string;
  /**
   * The request's tool/function definitions, recorded immediately via
   * {@link Generation.setToolDefinitions} — verbatim, any provider shape.
   */
  tools?: unknown[];
  /**
   * End-user identity (`user.id`). Sugar for `withUser`: set on this span at
   * creation and, for the scoped variant, on every span opened inside it.
   */
  userId?: string;
  /**
   * Operation name (`gen_ai.operation.name`); default `"chat"`. Set it for
   * `text_completion`, `embeddings` or `generate_content` calls, as the
   * Python SDK's `operation=` allows.
   */
  operation?: string;
}

/** An LLM call. Content uses gen_ai message keys, never input.value. */
export class Generation extends Observation {
  private firstTokenRecorded = false;

  /**
   * The provider passed at creation; drives the Anthropic input-token summing
   * in {@link setUsage}. A bare `new Generation(span)` has none and never sums.
   */
  constructor(
    span: ConstructorParameters<typeof Observation>[0],
    private readonly provider?: string,
  ) {
    super(span);
  }

  /**
   * Record the request messages (`gen_ai.input.messages`), normalised to the
   * GenAI `{role, parts}` shape like the Python SDK does: bare strings, OpenAI
   * dicts (including `tool_calls` and tool responses) and multimodal content
   * lists are all accepted. Bare strings default to the `user` role.
   */
  setInput(value: unknown): this {
    this.span.setAttribute(GEN_AI_INPUT_MESSAGES, serializeMessages(value, "user"));
    return this;
  }

  /** Record the response messages (`gen_ai.output.messages`); bare strings default to `assistant`. */
  setOutput(value: unknown): this {
    this.span.setAttribute(GEN_AI_OUTPUT_MESSAGES, serializeMessages(value, "assistant"));
    return this;
  }

  /**
   * The request's tool/function definitions (`gen_ai.tool.definitions`).
   * Serialized verbatim, in whatever shape the provider request used (OpenAI
   * nests each tool under `function`, Anthropic uses top-level
   * `name`/`input_schema`) — no normalization, so what is recorded is exactly
   * what the model was shown. Definitions are content, not identity: they are
   * masked/stripped under `captureContent: false` like messages are.
   */
  setToolDefinitions(tools: unknown[]): this {
    this.span.setAttribute(GEN_AI_TOOL_DEFINITIONS, toAttributeValue(tools));
    return this;
  }

  setModel(model: string): this {
    this.span.setAttribute(GEN_AI_RESPONSE_MODEL, model);
    return this;
  }

  /**
   * Token usage (`gen_ai.usage.*`). Pass provider-reported values as-is;
   * never pre-add anything. Per the GenAI conventions, `inputTokens` is the
   * total including cached tokens (the cache counts are subsets of it).
   * Anthropic's API reports `input_tokens` excluding the cache counts, and
   * the conventions require the instrumentation to do the summing, so when
   * the generation's provider is `"anthropic"` the emitted total is
   * `inputTokens` plus both cache counts. Every other provider is recorded
   * verbatim.
   */
  setUsage(usage: {
    inputTokens?: number;
    outputTokens?: number;
    /** Input tokens served from a provider-managed prompt cache. */
    cacheReadInputTokens?: number;
    /**
     * Input tokens written to a provider-managed prompt cache
     * (called "cache creation" by Anthropic).
     */
    cacheWriteInputTokens?: number;
    /**
     * Output tokens spent on reasoning / extended thinking. A subset of
     * `outputTokens`, never in addition to it: providers already include
     * reasoning tokens in the output total, so pass both as reported and
     * do no arithmetic.
     */
    reasoningOutputTokens?: number;
  }): this {
    if (usage.inputTokens !== undefined) {
      const sums = this.provider?.toLowerCase() === "anthropic";
      const total = sums
        ? usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0)
        : usage.inputTokens;
      this.span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, total);
    }
    if (usage.outputTokens !== undefined) {
      this.span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, usage.outputTokens);
    }
    if (usage.cacheReadInputTokens !== undefined) {
      this.span.setAttribute(GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, usage.cacheReadInputTokens);
    }
    if (usage.cacheWriteInputTokens !== undefined) {
      this.span.setAttribute(GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS, usage.cacheWriteInputTokens);
    }
    if (usage.reasoningOutputTokens !== undefined) {
      this.span.setAttribute(GEN_AI_USAGE_REASONING_OUTPUT_TOKENS, usage.reasoningOutputTokens);
    }
    return this;
  }

  /**
   * Why generation stopped (`gen_ai.response.finish_reasons`), e.g. `"stop"`,
   * `"length"`, `"tool_calls"`. The convention is a list; a single reason is
   * wrapped so callers do not have to.
   */
  setFinishReasons(reasons: string | string[]): this {
    this.span.setAttribute(
      GEN_AI_RESPONSE_FINISH_REASONS,
      typeof reasons === "string" ? [reasons] : reasons,
    );
    return this;
  }

  /**
   * The TTFT anchor: event time minus span start. Idempotent: only the
   * first call records the event, so a streaming loop can call this
   * unconditionally on every chunk without inflating the span. A no-op
   * after the span has ended.
   */
  recordFirstToken(): this {
    if (this.firstTokenRecorded || !this.span.isRecording()) {
      return this;
    }
    this.span.addEvent(GEN_AI_FIRST_TOKEN_EVENT);
    this.firstTokenRecorded = true;
    return this;
  }
}

function attributesFor(options: GenerationOptions): Record<string, string> {
  const attributes: Record<string, string> = { ...kindAttributes(SpanKind.LLM) };
  if (options.operation !== undefined) attributes[GEN_AI_OPERATION_NAME] = options.operation;
  if (options.model !== undefined) attributes[GEN_AI_REQUEST_MODEL] = options.model;
  if (options.provider !== undefined) attributes[GEN_AI_PROVIDER_NAME] = options.provider;
  // Identity at creation so it lands even without UserSpanProcessor installed.
  if (options.userId !== undefined) attributes[USER_ID] = options.userId;
  return attributes;
}

function configure(generation: Generation, options: GenerationOptions): Generation {
  // After creation rather than in attributesFor: request parameters are not
  // identity attributes, and the key set is caller-supplied and open-ended.
  for (const [key, value] of Object.entries(options.modelParameters ?? {})) {
    generation.setAttribute(`${GEN_AI_REQUEST_PREFIX}${key}`, value);
  }
  if (options.reasoningLevel !== undefined) {
    generation.setAttribute(GEN_AI_REQUEST_REASONING_LEVEL, options.reasoningLevel);
  }
  if (options.tools !== undefined) generation.setToolDefinitions(options.tools);
  if (options.input !== undefined) generation.setInput(options.input);
  return generation;
}

/** Create a generation span and return a handle. You MUST call end(). */
export function startGeneration(name: string, options: GenerationOptions = {}): Generation {
  const span = getTracer().startSpan(name, { attributes: attributesFor(options) });
  return configure(new Generation(span, options.provider), options);
}

/** The body of a scoped generation. */
export type GenerationBody<T> = (generation: Generation) => Promise<T> | T;

/**
 * Run `fn` with a generation span active. Auto-ends, records exceptions.
 *
 * `options` is optional, so `startAsCurrentGeneration(name, fn)` works without
 * an empty object. The callback stays last.
 */
export function startAsCurrentGeneration<T>(name: string, fn: GenerationBody<T>): Promise<T>;
export function startAsCurrentGeneration<T>(
  name: string,
  options: GenerationOptions,
  fn: GenerationBody<T>,
): Promise<T>;
export function startAsCurrentGeneration<T>(
  name: string,
  optionsOrFn: GenerationOptions | GenerationBody<T>,
  maybeFn?: GenerationBody<T>,
): Promise<T> {
  const [options, fn] =
    typeof optionsOrFn === "function"
      ? [{} as GenerationOptions, optionsOrFn]
      : [optionsOrFn, maybeFn as GenerationBody<T>];

  return runActive(
    name,
    attributesFor(options),
    options.userId,
    (span) => configure(new Generation(span, options.provider), options),
    fn,
  );
}
