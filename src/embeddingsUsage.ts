import { type Span, trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  LLM_TOKEN_COUNT_PROMPT,
  LLM_TOKEN_COUNT_TOTAL,
  OPENINFERENCE_SPAN_KIND,
  SpanKind,
} from "./semconv.js";

/**
 * Token counts for OpenAI embeddings calls, which the OpenInference JS
 * instrumentation (through 4.4.1) does not record: its embeddings wrapper sets
 * the vectors and nothing from `response.usage`, while its chat and
 * completions wrappers record usage and the Python instrumentor records it for
 * embeddings too. Without this, an embeddings call from a Node app reaches the
 * backend with no usage, is not priced, and is missing from token totals.
 *
 * The counts are written in the instrumentor's own spelling,
 * `llm.token_count.prompt` / `.total`, onto the instrumentor's embedding span,
 * so the normalizer maps them exactly as it maps the Python instrumentor's and
 * the span looks the same as one from a fixed instrumentor would. Counts only:
 * no content is read or recorded, so this works with content capture off.
 *
 * Placement is what makes it work. The OpenInference wrapper starts its span,
 * runs the method it wrapped inside that span's context, and ends the span in
 * its own `.then`. So this wrapper is installed on the prototype BEFORE
 * OpenInference patches it, and ends up underneath: the active span inside it
 * is the embedding span, and its `.then` runs before the instrumentor's ends
 * that span. Installed on top it would see the caller's span and an ended one.
 *
 * Once the instrumentor records usage itself, its `.then` runs after this one
 * and writes the same keys with the provider's same values, so nothing differs.
 */

interface EmbeddingsUsageState {
  original: (...args: unknown[]) => unknown;
  active: boolean;
}

type CreateMethod = ((...args: unknown[]) => unknown) & {
  riusEmbeddingsUsage?: EmbeddingsUsageState;
  // shimmer's marker for the method a wrapper replaced; OpenTelemetry
  // instrumentations (OpenInference's included) wrap through it.
  __original?: CreateMethod;
};

/**
 * The attributes of a live span. The OpenInference tracer hands out its own
 * span wrapper (OISpan, which applies its masking config on write) holding the
 * SDK span in a `span` field and exposing no attributes of its own, so that
 * inner span is where they are read from.
 */
function attributesOf(span: Span): ReadableSpan["attributes"] | undefined {
  const inner = (span as unknown as { span?: unknown }).span ?? span;
  return (inner as Partial<ReadableSpan>).attributes;
}

/** The embedding span the instrumentor made for this call, or undefined. */
function embeddingSpan(span: Span | undefined): Span | undefined {
  if (span === undefined || !span.isRecording()) return undefined;
  return attributesOf(span)?.[OPENINFERENCE_SPAN_KIND] === SpanKind.EMBEDDING ? span : undefined;
}

function count(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

/**
 * Write the response's token counts onto `span`, leaving any count already
 * there alone. Never throws.
 *
 * @internal Exported for tests. Not re-exported from the package entry point.
 */
export function recordEmbeddingsUsageOn(span: Span, response: unknown): void {
  try {
    const usage = (response as { usage?: Record<string, unknown> } | null | undefined)?.usage;
    if (usage === undefined || usage === null) return;
    const attributes = attributesOf(span) ?? {};
    const prompt = count(usage.prompt_tokens);
    const total = count(usage.total_tokens);
    if (prompt !== undefined && attributes[LLM_TOKEN_COUNT_PROMPT] === undefined) {
      span.setAttribute(LLM_TOKEN_COUNT_PROMPT, prompt);
    }
    if (total !== undefined && attributes[LLM_TOKEN_COUNT_TOTAL] === undefined) {
      span.setAttribute(LLM_TOKEN_COUNT_TOTAL, total);
    }
  } catch {
    // Telemetry must never break the user's call.
  }
}

/** This wrapper, wherever it sits in the chain of wrappers on `create`. */
function findInstalled(create: CreateMethod | undefined): EmbeddingsUsageState | undefined {
  for (let method = create; method !== undefined; method = method.__original) {
    if (method.riusEmbeddingsUsage !== undefined) return method.riusEmbeddingsUsage;
  }
  return undefined;
}

/**
 * Install the embeddings-usage wrapper on the OpenAI build in `patchable`
 * (`{ OpenAI }`, as `openaiPatchable` returns it). Call it right before the
 * OpenInference instrumentation patches the same build. Returns an uninstall.
 *
 * Re-installing reactivates the wrapper already in the chain rather than
 * stacking a second: shutdown() runs this uninstall before the instrumentation
 * is disabled, so the wrapper can survive underneath the instrumentor's and is
 * found there by the next init(). If the method was already wrapped by
 * someone else and not by us, nothing is installed, since a wrapper on top of
 * the instrumentor's would only ever see ended spans.
 *
 * @internal Exported for tests. Not re-exported from the package entry point.
 */
export function installEmbeddingsUsage(patchable: object): () => void {
  const cls = (patchable as { OpenAI?: { Embeddings?: { prototype?: Record<string, unknown> } } })
    .OpenAI;
  const prototype = cls?.Embeddings?.prototype;
  const current = prototype?.create as CreateMethod | undefined;
  if (prototype === undefined || typeof current !== "function") return () => {};

  const installed = findInstalled(current);
  if (installed !== undefined) {
    installed.active = true;
    return () => {
      installed.active = false;
    };
  }
  if (current.__original !== undefined) return () => {};

  const state: EmbeddingsUsageState = { original: current, active: true };
  const wrapped: CreateMethod = function riusEmbeddingsCreate(this: unknown, ...args: unknown[]) {
    const result = state.original.apply(this, args);
    if (!state.active) return result;
    const span = embeddingSpan(trace.getActiveSpan());
    if (span === undefined) return result;
    const record = (response: unknown): unknown => {
      recordEmbeddingsUsageOn(span, response);
      return response;
    };
    try {
      // The client returns an APIPromise; `_thenUnwrap` keeps it one, so
      // `.withResponse()` and `.asResponse()` still work on what the caller gets.
      const unwrap = (result as { _thenUnwrap?: unknown } | null)?._thenUnwrap;
      if (typeof unwrap === "function") {
        return (unwrap as (fn: (data: unknown) => unknown) => unknown).call(result, record);
      }
      if (result instanceof Promise) return result.then(record);
    } catch {
      // Fall through to the untouched result.
    }
    return result;
  };
  wrapped.riusEmbeddingsUsage = state;
  prototype.create = wrapped;

  return () => {
    state.active = false;
    if (prototype.create === wrapped) prototype.create = state.original;
  };
}
