import type { Attributes } from "@opentelemetry/api";
import { getTracer } from "./client.js";
import { COMPACTION_OPERATION, markNextLlmSpanCompacted } from "./compaction.js";
import {
  composeSpanName,
  GEN_AI_OPERATION_NAME,
  kindAttributes,
  otelSpanKind,
  RIUS_COMPACTION_EXECUTOR,
  RIUS_COMPACTION_EXECUTOR_CLIENT,
  RIUS_COMPACTION_KIND,
  RIUS_COMPACTION_KIND_CLEAR_THINKING,
  RIUS_COMPACTION_KIND_CLEAR_TOOL_RESULTS,
  RIUS_COMPACTION_KIND_SUMMARIZE,
  RIUS_COMPACTION_KIND_TRUNCATE,
  RIUS_COMPACTION_MESSAGES_COMPACTED,
  RIUS_COMPACTION_MESSAGES_KEPT,
  RIUS_COMPACTION_SUMMARY_BYTES,
  RIUS_COMPACTION_SUMMARY_TEXT,
  RIUS_COMPACTION_TOKENS_AFTER,
  RIUS_COMPACTION_TOKENS_BEFORE,
  RIUS_COMPACTION_TOKENS_DROPPED,
  RIUS_COMPACTION_TRIGGER,
  RIUS_COMPACTION_TRIGGER_AUTO,
  RIUS_COMPACTION_TRIGGER_MANUAL,
  SpanKind,
} from "./semconv.js";

/**
 * How the context was shrunk: a summary replaces older turns (`summarize`),
 * old tool results are emptied (`clear_tool_results`), old thinking blocks
 * are dropped (`clear_thinking`), or old turns are cut with nothing in their
 * place (`truncate`).
 */
export type CompactionKind =
  | typeof RIUS_COMPACTION_KIND_SUMMARIZE
  | typeof RIUS_COMPACTION_KIND_CLEAR_TOOL_RESULTS
  | typeof RIUS_COMPACTION_KIND_CLEAR_THINKING
  | typeof RIUS_COMPACTION_KIND_TRUNCATE;

/** Why it ran: `auto` when the context neared its limit, `manual` when someone asked. */
export type CompactionTrigger =
  | typeof RIUS_COMPACTION_TRIGGER_AUTO
  | typeof RIUS_COMPACTION_TRIGGER_MANUAL;

/** Options for {@link markCompaction}. */
export interface MarkCompactionOptions {
  /** Defaults to `summarize`. */
  kind?: CompactionKind;
  /** Left unset when you cannot tell. */
  trigger?: CompactionTrigger;
  /** Size of the context the compaction started from, in the model's tokens. */
  tokensBefore?: number;
  /** Size of the context it left behind, measured the same way. */
  tokensAfter?: number;
  /** How many messages were summarized, cut or emptied. */
  messagesCompacted?: number;
  /** How many messages the next call still sees unchanged. */
  messagesKept?: number;
  /**
   * What the summary said. Content: withheld under `captureContent: false`
   * (its size is still recorded) and passed through `mask` otherwise.
   */
  summary?: string;
}

const KINDS: readonly string[] = [
  RIUS_COMPACTION_KIND_SUMMARIZE,
  RIUS_COMPACTION_KIND_CLEAR_TOOL_RESULTS,
  RIUS_COMPACTION_KIND_CLEAR_THINKING,
  RIUS_COMPACTION_KIND_TRUNCATE,
];

const TRIGGERS: readonly string[] = [RIUS_COMPACTION_TRIGGER_AUTO, RIUS_COMPACTION_TRIGGER_MANUAL];

function oneOf(name: string, value: unknown, allowed: readonly string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(`markCompaction: ${name} must be one of ${allowed.join(", ")}`);
  }
}

function checkCount(name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`markCompaction: ${name} must be a non-negative integer`);
  }
  return value;
}

/**
 * Record that your own code compacted the context: a span with
 * `gen_ai.operation.name` `compaction`, `rius.compaction.executor` `client` and
 * the fields you give, as a child of the current span (a root when there is
 * none). It is a point in time, so the span ends before this returns.
 *
 * The next LLM span started in the same async context is then marked
 * `gen_ai.conversation.compacted`, once: it is the first call that ran on the
 * compacted context. Call it in the flow that makes that call. A mark made in
 * an `async` function's synchronous prefix, before its first `await`, is also
 * seen by the caller that went on to call it, because the mark belongs to the
 * context it ran in.
 *
 * Throws a `TypeError` for an unknown `kind` or `trigger`, or a count that is
 * not a non-negative integer, before recording anything. Does nothing but
 * validate when no client is initialized.
 *
 * Compactions the provider reports in a response (Anthropic context editing
 * and compaction blocks, OpenAI Responses `compaction` items) are recorded
 * for you as `rius.compaction` events on the LLM span, when the response is
 * not streamed: a streamed reply reaches the instrumentation as accumulated
 * text, without the provider's compaction data. OpenAI's standalone
 * `/responses/compact` endpoint is not instrumented, so mark that one here.
 *
 * ```typescript
 * const summary = await summarize(history)
 * markCompaction({ trigger: "auto", tokensBefore: 150_000, tokensAfter: 12_000, summary })
 * await llm.chat(compactedHistory) // this call's span: gen_ai.conversation.compacted
 * ```
 */
export function markCompaction(options: MarkCompactionOptions = {}): void {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("markCompaction: options must be an object");
  }
  const kind = options.kind ?? RIUS_COMPACTION_KIND_SUMMARIZE;
  oneOf("kind", kind, KINDS);
  if (options.trigger !== undefined) oneOf("trigger", options.trigger, TRIGGERS);
  const before = checkCount("tokensBefore", options.tokensBefore);
  const after = checkCount("tokensAfter", options.tokensAfter);
  const compacted = checkCount("messagesCompacted", options.messagesCompacted);
  const kept = checkCount("messagesKept", options.messagesKept);
  if (options.summary !== undefined && typeof options.summary !== "string") {
    throw new TypeError("markCompaction: summary must be a string");
  }

  const attributes: Attributes = {
    ...kindAttributes(SpanKind.CHAIN),
    [GEN_AI_OPERATION_NAME]: COMPACTION_OPERATION,
    [RIUS_COMPACTION_KIND]: kind,
    [RIUS_COMPACTION_EXECUTOR]: RIUS_COMPACTION_EXECUTOR_CLIENT,
  };
  if (options.trigger !== undefined) attributes[RIUS_COMPACTION_TRIGGER] = options.trigger;
  if (before !== undefined) attributes[RIUS_COMPACTION_TOKENS_BEFORE] = before;
  if (after !== undefined) attributes[RIUS_COMPACTION_TOKENS_AFTER] = after;
  if (before !== undefined && after !== undefined && before >= after) {
    attributes[RIUS_COMPACTION_TOKENS_DROPPED] = before - after;
  }
  if (compacted !== undefined) attributes[RIUS_COMPACTION_MESSAGES_COMPACTED] = compacted;
  if (kept !== undefined) attributes[RIUS_COMPACTION_MESSAGES_KEPT] = kept;
  if (options.summary !== undefined) {
    attributes[RIUS_COMPACTION_SUMMARY_BYTES] = Buffer.byteLength(options.summary, "utf8");
    attributes[RIUS_COMPACTION_SUMMARY_TEXT] = options.summary;
  }

  getTracer()
    .startSpan(composeSpanName(SpanKind.CHAIN, attributes), {
      kind: otelSpanKind(SpanKind.CHAIN),
      attributes,
    })
    .end();
  markNextLlmSpanCompacted();
}
