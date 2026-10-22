import { AsyncLocalStorage } from "node:async_hooks";
import type { Attributes, AttributeValue, Context } from "@opentelemetry/api";
import { getNumberFromEnv } from "@opentelemetry/core";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  GEN_AI_CONVERSATION_COMPACTED,
  GEN_AI_OPERATION_NAME,
  kindForOperation,
  OPENINFERENCE_SPAN_KIND,
  OUTPUT_MIME_TYPE,
  OUTPUT_VALUE,
  RIUS_COMPACTION_EVENT,
  RIUS_COMPACTION_EXECUTOR,
  RIUS_COMPACTION_EXECUTOR_PROVIDER,
  RIUS_COMPACTION_ID,
  RIUS_COMPACTION_KIND,
  RIUS_COMPACTION_KIND_CLEAR_THINKING,
  RIUS_COMPACTION_KIND_CLEAR_TOOL_RESULTS,
  RIUS_COMPACTION_KIND_SUMMARIZE,
  RIUS_COMPACTION_SUMMARY_BYTES,
  RIUS_COMPACTION_SUMMARY_TEXT,
  RIUS_COMPACTION_TOKENS_AFTER,
  RIUS_COMPACTION_TOKENS_BEFORE,
  RIUS_COMPACTION_TOKENS_DROPPED,
  RIUS_COMPACTION_TOOL_RESULTS_CLEARED,
  SpanKind,
} from "./semconv.js";
import { textValue } from "./serde.js";

/**
 * Compactions, from the two places they are learned.
 *
 * A provider that compacts the context inside a request says so in its
 * response body, which the OpenInference instrumentations record whole as
 * `output.value`: this module reads it there and adds `rius.compaction` span
 * events (see {@link addProviderCompactions}). A caller that compacts its own
 * history says so through `markCompaction`, and the LLM call that then runs on
 * the compacted context is flagged `gen_ai.conversation.compacted` by
 * {@link CompactionFlagSpanProcessor}.
 */

/**
 * The `gen_ai.operation.name` of a span that is a compaction step of its own.
 * The registry maps the operation to CHAIN but exports no constant for it, so
 * the value is spelled here and a test pins it to that mapping.
 */
export const COMPACTION_OPERATION = "compaction";

/** The attributes of one `rius.compaction` event. */
type EventAttributes = Record<string, AttributeValue>;

type Bag = Readonly<Record<string, unknown>>;

/** A non-null, non-array object, or nothing: JSON arrays and scalars are not payload members. */
function asBag(value: unknown): Bag | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Bag)
    : undefined;
}

/** An own member of a parsed payload, so `constructor` or `__proto__` never resolves up the chain. */
function member(bag: Bag | undefined, key: string): unknown {
  return bag !== undefined && Object.hasOwn(bag, key) ? bag[key] : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** A non-empty string, or nothing. */
function identifier(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * What a compaction removed: `before` minus `after`, when both are known and
 * the context did not grow. A larger `after` has dropped nothing to report,
 * so it yields nothing rather than a negative count.
 */
export function droppedTokens(
  before: number | undefined,
  after: number | undefined,
): number | undefined {
  return before === undefined || after === undefined || after > before ? undefined : before - after;
}

/** The members of a list that are objects, in order; anything else in it is not a member. */
function members(value: unknown): Bag[] {
  if (!Array.isArray(value)) return [];
  const found: Bag[] = [];
  for (const raw of value) {
    const bag = asBag(raw);
    if (bag !== undefined) found.push(bag);
  }
  return found;
}

function set(event: EventAttributes, key: string, value: AttributeValue | undefined): void {
  if (value !== undefined) event[key] = value;
}

/**
 * No trigger: the provider decides when to compact and does not say why, so
 * `rius.compaction.trigger` stays unset, as the Python SDK leaves it.
 */
function providerEvent(kind: string): EventAttributes {
  return {
    [RIUS_COMPACTION_KIND]: kind,
    [RIUS_COMPACTION_EXECUTOR]: RIUS_COMPACTION_EXECUTOR_PROVIDER,
  };
}

const COMPACTION_TYPE = "compaction";

/**
 * Anthropic names an edit by family and date (`clear_tool_uses_20250919`), so
 * a newer date of a known family is still that family.
 */
const EDIT_KIND_BY_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ["clear_tool_uses", RIUS_COMPACTION_KIND_CLEAR_TOOL_RESULTS],
  ["clear_thinking", RIUS_COMPACTION_KIND_CLEAR_THINKING],
];

/** Anthropic context editing: one event per applied edit that names a kind we know. */
function contextEditingEvents(payload: Bag): EventAttributes[] {
  const edits = members(member(asBag(member(payload, "context_management")), "applied_edits"));
  const events: EventAttributes[] = [];
  for (const edit of edits) {
    const type = member(edit, "type");
    const kind =
      typeof type === "string"
        ? EDIT_KIND_BY_PREFIX.find(([prefix]) => type.startsWith(prefix))?.[1]
        : undefined;
    if (kind === undefined) continue;
    const event = providerEvent(kind);
    set(event, RIUS_COMPACTION_TOKENS_DROPPED, count(member(edit, "cleared_input_tokens")));
    if (kind === RIUS_COMPACTION_KIND_CLEAR_TOOL_RESULTS) {
      set(event, RIUS_COMPACTION_TOOL_RESULTS_CLEARED, count(member(edit, "cleared_tool_uses")));
    }
    events.push(event);
  }
  return events;
}

/**
 * Anthropic threshold compaction: a `compaction` content block holding the
 * summary, and the request's `usage.iterations` for the sizes.
 *
 * The compaction iteration is the one that read the context being compacted,
 * and the Nth block takes the size of the Nth compaction iteration. What it
 * left behind is what the first sampling iteration after it read, so a
 * compaction nothing sampled after has no size left to report.
 */
function compactionBlockEvents(payload: Bag): EventAttributes[] {
  const iterations = members(member(asBag(member(payload, "usage")), "iterations"));
  const compactions = iterations.flatMap((iteration, index) =>
    member(iteration, "type") === COMPACTION_TYPE ? [index] : [],
  );
  const sizes = compactions.map((index) => ({
    before: count(member(iterations[index], "input_tokens")),
    after: count(
      member(
        iterations.slice(index + 1).find((later) => member(later, "type") !== COMPACTION_TYPE),
        "input_tokens",
      ),
    ),
  }));
  const blocks = members(member(payload, "content")).filter(
    (block) => member(block, "type") === COMPACTION_TYPE,
  );
  const events: EventAttributes[] = [];
  blocks.forEach((block, position) => {
    const summary = member(block, "content");
    // No summary is a compaction that failed: the server treats the block as a
    // no-op, so nothing was compacted and nothing is reported.
    if (typeof summary !== "string") return;
    const { before, after } = sizes[position] ?? {};
    const event = providerEvent(RIUS_COMPACTION_KIND_SUMMARIZE);
    set(event, RIUS_COMPACTION_TOKENS_BEFORE, before);
    set(event, RIUS_COMPACTION_TOKENS_AFTER, after);
    set(event, RIUS_COMPACTION_TOKENS_DROPPED, droppedTokens(before, after));
    event[RIUS_COMPACTION_SUMMARY_BYTES] = Buffer.byteLength(summary, "utf8");
    event[RIUS_COMPACTION_SUMMARY_TEXT] = textValue(summary);
    set(event, RIUS_COMPACTION_ID, identifier(member(block, "id")));
    events.push(event);
  });
  return events;
}

/**
 * An OpenAI Responses `compaction` output item. Its encrypted content is an
 * opaque carry-over for the next request and is never read.
 */
function compactionItemEvents(payload: Bag): EventAttributes[] {
  const events: EventAttributes[] = [];
  for (const item of members(member(payload, "output"))) {
    if (member(item, "type") !== COMPACTION_TYPE) continue;
    const event = providerEvent(RIUS_COMPACTION_KIND_SUMMARIZE);
    set(event, RIUS_COMPACTION_ID, identifier(member(item, "id")));
    events.push(event);
  }
  return events;
}

/**
 * Present in every response that reports a compaction, which a response that
 * reports none almost never contains, so the common reply is never parsed. A
 * reply that merely mentions one of them is parsed and finds nothing.
 */
const MARKERS = ['"compaction"', '"applied_edits"'];

/**
 * What `POST /responses/compact` answers with. That call is the compaction
 * itself, not a request that ran on a compacted context.
 */
const COMPACT_ENDPOINT_OBJECT = "response.compaction";

/**
 * The compactions an LLM span's provider response reports, as event
 * attributes, or nothing.
 *
 * The payload is read like `responseIdFromOutput` reads it: an LLM span whose
 * `output.value`, undeclared or declared JSON, is a string starting with `{`.
 * That is the whole response for a call that is not streamed, and for a
 * streamed OpenAI Responses call too: the instrumentation records the
 * `response.completed` event's response as JSON. A streamed Anthropic or
 * OpenAI chat reply is recorded as its accumulated text (`text/plain`), which
 * carries none of this, so those report no compaction. The payload is the
 * provider's and untrusted: every member is read as an own property, and a
 * field of the wrong type is left out rather than guessed.
 */
export function providerCompactions(
  attributes: Readonly<Record<string, AttributeValue | undefined>>,
): EventAttributes[] {
  if (attributes[OPENINFERENCE_SPAN_KIND] !== SpanKind.LLM) return [];
  const mime = attributes[OUTPUT_MIME_TYPE];
  if (mime !== undefined && mime !== "application/json") return [];
  const output = attributes[OUTPUT_VALUE];
  if (typeof output !== "string" || !output.startsWith("{")) return [];
  // The body can be large: do not parse what cannot hold a compaction.
  if (!MARKERS.some((marker) => output.includes(marker))) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  const payload = asBag(parsed);
  if (payload === undefined || member(payload, "object") === COMPACT_ENDPOINT_OBJECT) return [];
  return [
    ...contextEditingEvents(payload),
    ...compactionBlockEvents(payload),
    ...compactionItemEvents(payload),
  ];
}

/** The variable OpenTelemetry reads for the span event count limit. */
export const EVENT_COUNT_LIMIT_ENV = "OTEL_SPAN_EVENT_COUNT_LIMIT";

/** OpenTelemetry's default for events per span. */
export const DEFAULT_SPAN_EVENT_COUNT_LIMIT = 128;

/**
 * Add a `rius.compaction` event for each compaction the span's provider
 * response reports, and mark the span `gen_ai.conversation.compacted`.
 *
 * Does nothing when the span already carries a `rius.compaction` event: a
 * producer that recorded its own compaction knows more than the response
 * does, and a second pass over the same span must not double it. The event
 * is stamped with the span's end, the moment the response was complete.
 * Runs at `onEnd`, before masking, so the summary text is masked or stripped
 * like any other content.
 *
 * The events go straight onto the ended span's list, which the span's own
 * `addEvent` would no longer take, so the span's event count limit is applied
 * here: what does not fit is counted as dropped, as the span would count it.
 * `eventCountLimit` is the limit the provider was built with; without one the
 * environment and OpenTelemetry's default stand in for it.
 * An event's attribute count is fixed and small, and its one large value, the
 * summary text, is already capped, so those limits need no pass of their own.
 */
export function addProviderCompactions(
  span: ReadableSpan,
  attributes: Record<string, AttributeValue | undefined>,
  eventCountLimit?: number,
): void {
  const events = span.events;
  if (!Array.isArray(events)) return;
  if (events.some((event) => event.name === RIUS_COMPACTION_EVENT)) return;
  const found = providerCompactions(attributes);
  if (found.length === 0) return;
  const limit =
    eventCountLimit ?? getNumberFromEnv(EVENT_COUNT_LIMIT_ENV) ?? DEFAULT_SPAN_EVENT_COUNT_LIMIT;
  const kept = found.slice(0, Math.max(0, limit - events.length));
  if (kept.length < found.length) {
    // A real span exposes the count through a getter only, which a plain
    // assignment would throw on; an own property shadows it.
    Object.defineProperty(span, "droppedEventsCount", {
      value: (span.droppedEventsCount ?? 0) + found.length - kept.length,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  if (kept.length === 0) return;
  const time = span.endTime ?? span.startTime ?? [0, 0];
  for (const event of kept) {
    events.push({
      name: RIUS_COMPACTION_EVENT,
      attributes: event as Attributes,
      time: [time[0], time[1]],
      droppedAttributesCount: 0,
    });
  }
  attributes[GEN_AI_CONVERSATION_COMPACTED] = true;
}

/**
 * Whether a span is a model call, by the same two spellings the rest of the
 * pipeline accepts: the taxonomy attribute, or a GenAI operation that maps to
 * LLM.
 */
function isLlmSpan(attributes: Readonly<Record<string, unknown>>): boolean {
  if (attributes[OPENINFERENCE_SPAN_KIND] === SpanKind.LLM) return true;
  const operation = attributes[GEN_AI_OPERATION_NAME];
  return typeof operation === "string" && kindForOperation(operation) === SpanKind.LLM;
}

/** Whether a span has said what it is yet: the OpenInference tracer says so only after the span has started. */
function isKnown(attributes: Readonly<Record<string, unknown>>): boolean {
  return (
    attributes[OPENINFERENCE_SPAN_KIND] !== undefined ||
    attributes[GEN_AI_OPERATION_NAME] !== undefined
  );
}

interface PendingFlag {
  pending: boolean;
}

/**
 * Whether a compaction has been marked in this async context and not yet
 * claimed by an LLM span. A mutable holder rather than a value, so that the
 * contexts that inherit it share one flag and the first LLM span to start
 * among them takes it.
 */
const pendingFlag = new AsyncLocalStorage<PendingFlag>();

/**
 * Remember that the context was compacted here, for the next LLM span started
 * in this async context to pick up.
 *
 * `enterWith` rather than `run`: the caller marks a compaction in the middle
 * of its own flow and has no callback to wrap the calls that follow. The
 * consequence is that the mark lives in the context `markCompaction` ran in,
 * so it must run in the flow that makes the next call.
 *
 * A fresh holder on every mark, never the one an enclosing context already
 * has: a holder is shared by every context that inherited it, so reusing it
 * would let one conversation's mark flag a sibling's call, and let the first
 * of two concurrent marks spend both.
 */
export function markNextLlmSpanCompacted(): void {
  pendingFlag.enterWith({ pending: true });
}

/** The key a span goes by from its start to its end, whichever object represents it at each. */
function spanKey(span: { spanContext(): { traceId: string; spanId: string } }): string {
  const { traceId, spanId } = span.spanContext();
  return `${traceId}:${spanId}`;
}

/**
 * Stamps `gen_ai.conversation.compacted` on the first LLM span that starts
 * after a `markCompaction` in the same async context.
 *
 * A span that says what it is when it starts is claimed or passed over then.
 * The OpenInference instrumentations do not: their tracer creates the span
 * bare and sets the kind afterwards, so it is not an LLM span yet at start. A
 * span that has not said what it is is remembered with the flag it saw, and
 * decided at end, when the kind is in. Among spans of that kind running at
 * once the first to end takes the flag.
 *
 * The span is remembered by its trace and span id, not by the object: a span
 * of another provider that Rius's bridge feeds is a twin at start and a copy
 * at end. The entry is removed when the span ends.
 *
 * Unlike the session and user ids it never reaches a pending snapshot: the key
 * is not on the identity allowlist, since it is learned from a call the
 * producer made, not from the request, and it is only ever set at start on a
 * span that is already an LLM span or at end.
 */
export class CompactionFlagSpanProcessor implements SpanProcessor {
  private readonly undecided = new Map<string, PendingFlag>();

  /**
   * @param maxUndecided How many undecided spans are remembered at once. A
   *   span that never ends is never removed, so without a bound each one
   *   would be held for the life of the process. Past it the oldest is
   *   forgotten, which only costs it the chance to take a flag.
   */
  constructor(private readonly maxUndecided = 10_000) {}

  onStart(span: Span, _parentContext: Context): void {
    const flag = pendingFlag.getStore();
    if (flag === undefined || !flag.pending) return;
    if (!isKnown(span.attributes)) {
      if (this.undecided.size >= this.maxUndecided) {
        // A Map iterates in insertion order: the first key is the oldest.
        const [oldest] = this.undecided.keys();
        if (oldest !== undefined) this.undecided.delete(oldest);
      }
      this.undecided.set(spanKey(span), flag);
      return;
    }
    if (!isLlmSpan(span.attributes)) return;
    flag.pending = false;
    span.setAttribute(GEN_AI_CONVERSATION_COMPACTED, true);
  }

  onEnd(span: ReadableSpan): void {
    const key = spanKey(span);
    const flag = this.undecided.get(key);
    if (flag === undefined) return;
    this.undecided.delete(key);
    if (!flag.pending || !isLlmSpan(span.attributes)) return;
    flag.pending = false;
    // In place, as normalization writes: the span has ended, so setAttribute
    // is a no-op, and the exporter reads this same object.
    (span.attributes as Record<string, AttributeValue | undefined>)[GEN_AI_CONVERSATION_COMPACTED] =
      true;
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
