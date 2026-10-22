import type { Attributes } from "@opentelemetry/api";
import { getTracer } from "./client.js";
import { COMPACTION_OPERATION, droppedTokens, markNextLlmSpanCompacted } from "./compaction.js";
import { errorType } from "./errorType.js";
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
import { textValue } from "./serde.js";
import { warnOnce } from "./warn.js";

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

/** A caller error in markCompaction's options; caught and reported as a warning. */
class InvalidOption extends Error {}

function oneOf(name: string, value: unknown, allowed: readonly string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new InvalidOption(`${name} must be one of ${allowed.join(", ")}`);
  }
}

function checkCount(name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidOption(`${name} must be a non-negative integer`);
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
 * compacted context. Call it in the flow that makes that call. The mark is
 * set with `AsyncLocalStorage.enterWith`, so it belongs to the async context
 * `markCompaction` ran in, and what sees it follows from that:
 *
 * - a mark made after an `await` inside a helper is not seen by the caller,
 *   which keeps its own context; only a mark in the synchronous prefix of an
 *   `async` function, before its first `await`, reaches the caller;
 * - an `async` function called eagerly (not yet awaited) that marks in its
 *   synchronous prefix also marks the context of every flow the caller
 *   creates afterwards, so mark in the flow that makes the call rather than
 *   in a helper that other concurrent flows are started beside.
 *
 * Never throws: an unknown `kind` or `trigger`, a count that is not a
 * non-negative integer, or a summary that is not a string logs a warning and
 * records nothing. Without an initialized client nothing is recorded, but the
 * arguments are still checked.
 *
 * Compactions the provider reports in a response (Anthropic context editing
 * and compaction blocks, OpenAI Responses `compaction` items) are recorded
 * for you as `rius.compaction` events on the LLM span, when the
 * instrumentation records the response as JSON: non-streamed Anthropic and
 * OpenAI Responses calls, and a streamed OpenAI Responses call, whose final
 * `response.completed` payload is recorded that way. A streamed Anthropic or
 * chat completions reply is recorded as accumulated text without the
 * provider's compaction data, so mark that one here. OpenAI's standalone
 * `/responses/compact` endpoint is not instrumented, so mark that one here too.
 *
 * ```typescript
 * const summary = await summarize(history)
 * markCompaction({ trigger: "auto", tokensBefore: 150_000, tokensAfter: 12_000, summary })
 * await llm.chat(compactedHistory) // this call's span: gen_ai.conversation.compacted
 * ```
 */
export function markCompaction(options: MarkCompactionOptions = {}): void {
  try {
    record(options);
  } catch (error) {
    // Anything else (a throwing getter on the options, say) is skipped too:
    // recording a compaction must never throw into the app.
    const why =
      error instanceof InvalidOption
        ? error.message
        : `the options could not be read (${errorType(error)})`;
    // Once per message: a wrong option is deterministic, so it would
    // otherwise warn on every turn of an agent loop.
    warnOnce(`markCompaction() skipped: ${why}; nothing was recorded.`);
  }
}

/** markCompaction's body; an invalid option throws InvalidOption before anything is recorded. */
function record(options: MarkCompactionOptions): void {
  if (typeof options !== "object" || options === null) {
    throw new InvalidOption("options must be an object");
  }
  const kind = options.kind ?? RIUS_COMPACTION_KIND_SUMMARIZE;
  oneOf("kind", kind, KINDS);
  if (options.trigger !== undefined) oneOf("trigger", options.trigger, TRIGGERS);
  const before = checkCount("tokensBefore", options.tokensBefore);
  const after = checkCount("tokensAfter", options.tokensAfter);
  const compacted = checkCount("messagesCompacted", options.messagesCompacted);
  const kept = checkCount("messagesKept", options.messagesKept);
  if (options.summary !== undefined && typeof options.summary !== "string") {
    throw new InvalidOption("summary must be a string");
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
  const dropped = droppedTokens(before, after);
  if (dropped !== undefined) attributes[RIUS_COMPACTION_TOKENS_DROPPED] = dropped;
  if (compacted !== undefined) attributes[RIUS_COMPACTION_MESSAGES_COMPACTED] = compacted;
  if (kept !== undefined) attributes[RIUS_COMPACTION_MESSAGES_KEPT] = kept;
  if (options.summary !== undefined) {
    attributes[RIUS_COMPACTION_SUMMARY_BYTES] = Buffer.byteLength(options.summary, "utf8");
  }

  const span = getTracer().startSpan(composeSpanName(SpanKind.CHAIN, attributes), {
    kind: otelSpanKind(SpanKind.CHAIN),
    attributes,
  });
  // After the start, never in its attributes: the text is content, and what a
  // span carries when it starts is what a pending snapshot is built from.
  if (options.summary !== undefined) {
    span.setAttribute(RIUS_COMPACTION_SUMMARY_TEXT, textValue(options.summary));
  }
  span.end();
  markNextLlmSpanCompacted();
}
