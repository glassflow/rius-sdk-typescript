import { getTracer } from "./client.js";
import {
  GEN_AI_FIRST_TOKEN_EVENT,
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_REQUEST_PREFIX,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  SpanKind,
  kindAttributes,
} from "./semconv.js";
import { toAttributeValue } from "./serde.js";
import { Observation } from "./spans.js";

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
}

/** An LLM call. Content uses gen_ai message keys, never input.value. */
export class Generation extends Observation {
  private firstTokenRecorded = false;

  setInput(value: unknown): this {
    this.span.setAttribute(GEN_AI_INPUT_MESSAGES, toAttributeValue(value));
    return this;
  }

  setOutput(value: unknown): this {
    this.span.setAttribute(GEN_AI_OUTPUT_MESSAGES, toAttributeValue(value));
    return this;
  }

  setModel(model: string): this {
    this.span.setAttribute(GEN_AI_RESPONSE_MODEL, model);
    return this;
  }

  setUsage(usage: { inputTokens?: number; outputTokens?: number }): this {
    if (usage.inputTokens !== undefined) {
      this.span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, usage.inputTokens);
    }
    if (usage.outputTokens !== undefined) {
      this.span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, usage.outputTokens);
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
  if (options.model !== undefined) attributes[GEN_AI_REQUEST_MODEL] = options.model;
  if (options.provider !== undefined) attributes[GEN_AI_PROVIDER_NAME] = options.provider;
  return attributes;
}

function configure(generation: Generation, options: GenerationOptions): Generation {
  // After creation rather than in attributesFor: request parameters are not
  // identity attributes, and the key set is caller-supplied and open-ended.
  for (const [key, value] of Object.entries(options.modelParameters ?? {})) {
    generation.setAttribute(`${GEN_AI_REQUEST_PREFIX}${key}`, value);
  }
  if (options.input !== undefined) generation.setInput(options.input);
  return generation;
}

/** Create a generation span and return a handle. You MUST call end(). */
export function startGeneration(name: string, options: GenerationOptions = {}): Generation {
  const span = getTracer().startSpan(name, { attributes: attributesFor(options) });
  return configure(new Generation(span), options);
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

  return getTracer().startActiveSpan(name, { attributes: attributesFor(options) }, async (span) => {
    const generation = configure(new Generation(span), options);
    try {
      return await fn(generation);
    } catch (error) {
      generation.recordException(error);
      throw error;
    } finally {
      generation.end();
    }
  });
}
