import { SpanStatusCode } from "@opentelemetry/api";
import { getTracer } from "./client.js";
import {
  GEN_AI_FIRST_TOKEN_EVENT,
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
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
}

/** An LLM call. Content uses gen_ai message keys, never input.value. */
export class Generation extends Observation {
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

  /** The TTFT anchor: event time minus span start. */
  recordFirstToken(): this {
    this.span.addEvent(GEN_AI_FIRST_TOKEN_EVENT);
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
  if (options.input !== undefined) generation.setInput(options.input);
  return generation;
}

/** Create a generation span and return a handle. You MUST call end(). */
export function startGeneration(name: string, options: GenerationOptions = {}): Generation {
  const span = getTracer().startSpan(name, { attributes: attributesFor(options) });
  return configure(new Generation(span), options);
}

/** Run `fn` with a generation span active. Auto-ends, records exceptions. */
export function startAsCurrentGeneration<T>(
  name: string,
  options: GenerationOptions,
  fn: (generation: Generation) => Promise<T> | T,
): Promise<T> {
  return getTracer().startActiveSpan(name, { attributes: attributesFor(options) }, async (span) => {
    const generation = configure(new Generation(span), options);
    try {
      return await fn(generation);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      generation.end();
    }
  });
}
