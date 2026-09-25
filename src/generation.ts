import type { AttributeValue } from "@opentelemetry/api";
import { getTracer } from "./client.js";
import { contextSizes } from "./contextSizes.js";
import { type Message, normalizeMessages } from "./messages.js";
import { REQUEST_PARAMETER_GUARDS } from "./normalize.js";
import {
  GEN_AI_FIRST_TOKEN_EVENT,
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OPERATION_NAME,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_OUTPUT_TYPE,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_REQUEST_PARAMETERS,
  GEN_AI_REQUEST_REASONING_LEVEL,
  GEN_AI_REQUEST_STREAM,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_RESPONSE_ID,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK,
  GEN_AI_TOOL_DEFINITIONS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  RIUS_CONTEXT_SIZES,
  RIUS_REQUEST_PREFIX,
  SpanKind,
  USER_ID,
  composeSpanName,
  kindAttributes,
  otelSpanKind,
  requestAttributeKey,
} from "./semconv.js";
import { attributeValue, toAttributeValue } from "./serde.js";
import { Observation, runActive, splitScopedArgs } from "./spans.js";

/**
 * Options for {@link startGeneration} and {@link startAsCurrentGeneration}:
 * the model identity and request parameters an LLM span carries.
 */
export interface GenerationOptions {
  model?: string;
  provider?: string;
  input?: unknown;
  /**
   * Request parameters, for example `{ temperature: 0.2, max_tokens: 512 }`,
   * recorded at span creation so they ride pending snapshots.
   *
   * A parameter the GenAI conventions define, under its canonical name or a
   * recognised provider spelling (OpenAI's `max_completion_tokens`, Google's
   * `maxOutputTokens`, a camelCase `topP`), is recorded under its canonical
   * `gen_ai.request.*` key and only that one. Everything else is recorded
   * under `rius.request.<key>`, this SDK's own namespace, with the key
   * otherwise untouched. Values that are not scalars or homogeneous scalar
   * arrays are JSON-encoded; `null` and `undefined` mean "not set" and are
   * skipped. The `model` and `reasoningLevel` options win over a parameter
   * that maps to the same key.
   */
  modelParameters?: Record<string, unknown>;
  /**
   * Requested reasoning/thinking effort level
   * (`gen_ai.request.reasoning.level`), e.g. OpenAI's `reasoning.effort`
   * values. Provider-defined string, recorded verbatim. Passing
   * `reasoning_effort` through `modelParameters` lands on the same key; this
   * option wins when both are given.
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
   * The output modality requested of the model (`gen_ai.output.type`) —
   * `"text"`, `"json"`, `"image"` or `"speech"` per the conventions, which
   * make it Conditionally Required when the request asks for a specific
   * output format. An option rather than a setter because it is a property of
   * the REQUEST: known before the call, so it is set at span creation and
   * reaches pending snapshots. The string is recorded verbatim, not validated
   * against the four members: the enum is open, and a provider's own spelling
   * is still what the caller asked for.
   */
  outputType?: string;
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
   * Monotonic clock at construction, which is span creation for both
   * `startGeneration` and the scoped form. The API `Span` exposes no start
   * time, so this is what `recordFirstToken` measures the first chunk against.
   */
  private readonly startedAt = performance.now();
  /**
   * The latest normalized input / output and the tool definitions, kept so
   * `rius.context.sizes` can be computed from all three once, in {@link end}.
   */
  private inputMessages?: Message[];
  private outputMessages?: Message[];
  private tools?: unknown[];

  /**
   * The provider passed at creation; drives the Anthropic input-token summing
   * in {@link setUsage}. A bare `new Generation(span)` has none and never sums.
   */
  constructor(
    span: ConstructorParameters<typeof Observation>[0],
    private readonly provider?: string,
  ) {
    super(span);
    // Every generation span carries the attribute: this seed stands in for a
    // span ended through the raw OTel handle instead of end().
    this.span.setAttribute(RIUS_CONTEXT_SIZES, contextSizes(undefined, undefined, undefined));
  }

  /**
   * Computed once, as the span ends, rather than on every content write: a
   * generation with tools, input and output would otherwise pay for it three
   * times, and only the last result matters. Derived from the normalized
   * messages BEFORE truncation, which is what makes it trustworthy when the
   * content attributes are not.
   */
  private setContextSizes(): void {
    if (!this.inputMessages && !this.outputMessages && !this.tools) return; // the seed stands
    this.span.setAttribute(
      RIUS_CONTEXT_SIZES,
      contextSizes(this.tools, this.inputMessages, this.outputMessages),
    );
  }

  /** Ends the span after recording the context sizes; idempotent like the base. */
  override end(): void {
    if (!this.ended) this.setContextSizes();
    super.end();
  }

  /**
   * Record the request messages (`gen_ai.input.messages`), normalised to the
   * GenAI `{role, parts}` shape like the Python SDK does: bare strings, OpenAI
   * dicts (including `tool_calls` and tool responses) and multimodal content
   * lists are all accepted. Bare strings default to the `user` role.
   */
  setInput(value: unknown): this {
    // Normalize once: the content attribute is the (truncated) serialization
    // of this list, and the sizes are measured on the same list, untruncated.
    this.inputMessages = normalizeMessages(value, "user");
    this.span.setAttribute(GEN_AI_INPUT_MESSAGES, toAttributeValue(this.inputMessages));
    return this;
  }

  /** Record the response messages (`gen_ai.output.messages`); bare strings default to `assistant`. */
  setOutput(value: unknown): this {
    this.outputMessages = normalizeMessages(value, "assistant");
    this.span.setAttribute(GEN_AI_OUTPUT_MESSAGES, toAttributeValue(this.outputMessages));
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
    this.tools = tools;
    this.span.setAttribute(GEN_AI_TOOL_DEFINITIONS, toAttributeValue(tools));
    return this;
  }

  setModel(model: string): this {
    this.span.setAttribute(GEN_AI_RESPONSE_MODEL, model);
    return this;
  }

  /**
   * The provider's identifier for this completion (`gen_ai.response.id`) —
   * OpenAI's `id`, Anthropic's `id`, and so on. A post-call setter and not a
   * creation option for the reason `setModel` is one: the value arrives WITH
   * the response, so no span can carry it at creation and no pending snapshot
   * can either. Recorded verbatim; it is an opaque provider string, and it is
   * not content, so it survives `captureContent: false`.
   */
  setResponseId(id: string): this {
    this.span.setAttribute(GEN_AI_RESPONSE_ID, id);
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
   * Mark the arrival of the first streamed token. Records the
   * `gen_ai.first_token` event (the timestamp the backend derives TTFT from)
   * and, per the GenAI conventions, the derived
   * `gen_ai.response.time_to_first_chunk` (seconds since span creation) plus
   * `gen_ai.request.stream = true`: a first chunk arriving is what tells the
   * SDK the request streamed. Idempotent: only the first call records, so a
   * streaming loop can call this unconditionally on every chunk without
   * inflating the span. A no-op after the span has ended.
   */
  recordFirstToken(): this {
    if (this.firstTokenRecorded || !this.span.isRecording()) {
      return this;
    }
    const elapsedSeconds = Math.max(performance.now() - this.startedAt, 0) / 1000;
    this.span.addEvent(GEN_AI_FIRST_TOKEN_EVENT);
    this.firstTokenRecorded = true;
    this.span.setAttribute(GEN_AI_REQUEST_STREAM, true);
    this.span.setAttribute(GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK, elapsedSeconds);
    return this;
  }
}

/**
 * Caller request parameters, keyed as they are recorded: spec-defined ones
 * (including recognised provider spellings) under their canonical
 * `gen_ai.request.*` key, everything else under `rius.request.<key>` with the
 * key otherwise untouched. `null` and `undefined` are "not set" and skipped.
 *
 * A canonical key carries only a value of its own type: each goes through the
 * key's guard in {@link REQUEST_PARAMETER_GUARDS}, the same one the normalizer
 * applies to `llm.invocation_parameters`, so a lone `stop` string becomes a
 * one-element list and a numeric string never reaches a numeric key. A value
 * its guard rejects was still sent to the model, so it lands under
 * `rius.request.<key>` unchanged instead.
 *
 * Two spellings of one parameter: the first in {@link GEN_AI_REQUEST_PARAMETERS}
 * order that passes its guard wins the canonical key, whatever order the
 * caller wrote them in, and the other is kept under `rius.request.<key>`. The
 * same rule as the Python SDK.
 */
function requestAttributes(
  modelParameters: Record<string, unknown> | undefined,
): Record<string, AttributeValue> {
  const parameters = new Map(
    Object.entries(modelParameters ?? {}).filter(([, value]) => value != null),
  );
  const attributes: Record<string, AttributeValue> = {};
  // Canonical spellings first, in precedence order, so the winner of a
  // collision is decided by the table and not by the caller's key order.
  for (const [spelling, canonical] of Object.entries(GEN_AI_REQUEST_PARAMETERS)) {
    if (!parameters.has(spelling)) continue;
    const value = parameters.get(spelling);
    parameters.delete(spelling);
    const guarded = REQUEST_PARAMETER_GUARDS[canonical](value);
    if (guarded !== undefined && !Object.hasOwn(attributes, canonical)) {
      attributes[canonical] = guarded;
    } else {
      const coerced = attributeValue(value);
      if (coerced !== undefined) attributes[`${RIUS_REQUEST_PREFIX}${spelling}`] = coerced;
    }
  }
  for (const [key, value] of parameters) {
    const coerced = attributeValue(value);
    if (coerced !== undefined) attributes[requestAttributeKey(key)] = coerced;
  }
  return attributes;
}

/**
 * Identity attributes for an LLM span at CREATION. Pending snapshots are
 * built at onStart from these, so anything set later is invisible to them.
 */
function attributesFor(options: GenerationOptions): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = { ...kindAttributes(SpanKind.LLM) };
  if (options.operation !== undefined) attributes[GEN_AI_OPERATION_NAME] = options.operation;
  // The request parameters go in FIRST so the dedicated options below win a
  // collision: someone who passes both `model: "gpt-4o"` and
  // `modelParameters: { model }` meant the explicit one, and the span name is
  // composed from it. Here rather than after the span exists because the
  // request is known before the call runs, and a live view of a stuck call
  // has to say how it was asked to run.
  Object.assign(attributes, requestAttributes(options.modelParameters));
  if (options.reasoningLevel !== undefined) {
    attributes[GEN_AI_REQUEST_REASONING_LEVEL] = options.reasoningLevel;
  }
  if (options.model !== undefined) attributes[GEN_AI_REQUEST_MODEL] = options.model;
  if (options.provider !== undefined) attributes[GEN_AI_PROVIDER_NAME] = options.provider;
  // Identity: a property of the request, so it belongs with the model and the
  // operation rather than with the post-call setters.
  if (options.outputType !== undefined) attributes[GEN_AI_OUTPUT_TYPE] = options.outputType;
  // Identity at creation so it lands even without UserSpanProcessor installed.
  if (options.userId !== undefined) attributes[USER_ID] = options.userId;
  return attributes;
}

function configure(generation: Generation, options: GenerationOptions): Generation {
  // Content, set after creation: it must never ride a pending snapshot. The
  // request parameters are already on the span from attributesFor.
  if (options.tools !== undefined) generation.setToolDefinitions(options.tools);
  if (options.input !== undefined) generation.setInput(options.input);
  return generation;
}

/**
 * The generation's name: the caller's, else the conventions' `{operation}
 * {model}` — `chat gpt-4o`, or `embeddings text-embedding-3-small` when the
 * operation was overridden, which is why this composes from the resolved
 * attributes instead of hardcoding `chat`. The REQUEST model, never the
 * response one: the response model is not known when the span is named, and
 * a pending snapshot must carry the same name as the final span.
 */
function resolveName(name: string | undefined, attributes: Record<string, AttributeValue>): string {
  return name ?? composeSpanName(SpanKind.LLM, attributes);
}

/**
 * Create a generation span and return a handle. You MUST call end().
 *
 * The name is optional; omitted, the span is named `{operation} {model}`.
 */
export function startGeneration(name: string, options?: GenerationOptions): Generation;
export function startGeneration(options?: GenerationOptions): Generation;
export function startGeneration(
  nameOrOptions?: string | GenerationOptions,
  maybeOptions?: GenerationOptions,
): Generation {
  const [name, options] =
    typeof nameOrOptions === "string"
      ? [nameOrOptions, maybeOptions ?? {}]
      : [undefined, nameOrOptions ?? {}];

  const attributes = attributesFor(options);
  const span = getTracer().startSpan(resolveName(name, attributes), {
    kind: otelSpanKind(SpanKind.LLM),
    attributes,
  });
  return configure(new Generation(span, options.provider), options);
}

/** The body of a scoped generation. */
export type GenerationBody<T> = (generation: Generation) => Promise<T> | T;

/**
 * Run `fn` with a generation span active. Auto-ends, records exceptions.
 *
 * Both the name and `options` are optional and the callback stays last, so
 * `startAsCurrentGeneration({ model: "gpt-4o" }, fn)` names the span
 * `chat gpt-4o` for you.
 */
export function startAsCurrentGeneration<T>(name: string, fn: GenerationBody<T>): Promise<T>;
export function startAsCurrentGeneration<T>(
  name: string,
  options: GenerationOptions,
  fn: GenerationBody<T>,
): Promise<T>;
export function startAsCurrentGeneration<T>(
  options: GenerationOptions,
  fn: GenerationBody<T>,
): Promise<T>;
export function startAsCurrentGeneration<T>(fn: GenerationBody<T>): Promise<T>;
export function startAsCurrentGeneration<T>(
  first: string | GenerationOptions | GenerationBody<T>,
  second?: GenerationOptions | GenerationBody<T>,
  third?: GenerationBody<T>,
): Promise<T> {
  const { name, options, fn } = splitScopedArgs<GenerationOptions, GenerationBody<T>>(
    first,
    second,
    third,
  );
  const attributes = attributesFor(options);

  return runActive(
    resolveName(name, attributes),
    attributes,
    options.userId,
    (span) => configure(new Generation(span, options.provider), options),
    fn,
    otelSpanKind(SpanKind.LLM),
  );
}
