import { AsyncLocalStorage } from "node:async_hooks";
import type { Attributes, AttributeValue, Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  GEN_AI_CONVERSATION_COMPACTED,
  GEN_AI_OPERATION_NAME,
  kindForOperation,
  OPENINFERENCE_SPAN_KIND,
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
  RIUS_COMPACTION_TRIGGER,
  RIUS_COMPACTION_TRIGGER_AUTO,
  SpanKind,
} from "./semconv.js";

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

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function providerEvent(kind: string): EventAttributes {
  return {
    [RIUS_COMPACTION_KIND]: kind,
    [RIUS_COMPACTION_EXECUTOR]: RIUS_COMPACTION_EXECUTOR_PROVIDER,
    [RIUS_COMPACTION_TRIGGER]: RIUS_COMPACTION_TRIGGER_AUTO,
  };
}

/** Anthropic context editing: one event per applied edit that names a kind we know. */
function contextEditingEvents(payload: Bag): EventAttributes[] {
  const edits = member(asBag(member(payload, "context_management")), "applied_edits");
  if (!Array.isArray(edits)) return [];
  const events: EventAttributes[] = [];
  for (const raw of edits) {
    const edit = asBag(raw);
    const type = member(edit, "type");
    if (typeof type !== "string") continue;
    const toolUses = type.startsWith("clear_tool_uses");
    if (!toolUses && !type.startsWith("clear_thinking")) continue;
    const event = providerEvent(
      toolUses ? RIUS_COMPACTION_KIND_CLEAR_TOOL_RESULTS : RIUS_COMPACTION_KIND_CLEAR_THINKING,
    );
    const dropped = count(member(edit, "cleared_input_tokens"));
    if (dropped !== undefined) event[RIUS_COMPACTION_TOKENS_DROPPED] = dropped;
    const cleared = count(member(edit, "cleared_tool_uses"));
    if (toolUses && cleared !== undefined) event[RIUS_COMPACTION_TOOL_RESULTS_CLEARED] = cleared;
    events.push(event);
  }
  return events;
}

/**
 * The context size before and after an Anthropic threshold compaction, from
 * the request's `usage.iterations`: the compaction iteration is what the
 * summary was made from, the last iteration is the call that ran on it.
 */
function iterationSizes(payload: Bag): { before?: number; after?: number } {
  const iterations = member(asBag(member(payload, "usage")), "iterations");
  if (!Array.isArray(iterations)) return {};
  const at = iterations.findIndex((it) => member(asBag(it), "type") === "compaction");
  if (at === -1) return {};
  const sizes: { before?: number; after?: number } = {};
  sizes.before = count(member(asBag(iterations[at]), "input_tokens"));
  if (at < iterations.length - 1) {
    sizes.after = count(member(asBag(iterations[iterations.length - 1]), "input_tokens"));
  }
  return sizes;
}

/** Anthropic threshold compaction: a `compaction` content block holding the summary. */
function compactionBlockEvents(payload: Bag): EventAttributes[] {
  const content = member(payload, "content");
  if (!Array.isArray(content)) return [];
  const events: EventAttributes[] = [];
  const sizes = iterationSizes(payload);
  for (const raw of content) {
    const block = asBag(raw);
    if (member(block, "type") !== "compaction") continue;
    const event = providerEvent(RIUS_COMPACTION_KIND_SUMMARIZE);
    // The iterations describe the request's one compaction, so only the first
    // block takes them.
    if (events.length === 0) {
      if (sizes.before !== undefined) event[RIUS_COMPACTION_TOKENS_BEFORE] = sizes.before;
      if (sizes.after !== undefined) event[RIUS_COMPACTION_TOKENS_AFTER] = sizes.after;
    }
    const summary = text(member(block, "content"));
    if (summary !== undefined) {
      event[RIUS_COMPACTION_SUMMARY_BYTES] = Buffer.byteLength(summary, "utf8");
      event[RIUS_COMPACTION_SUMMARY_TEXT] = summary;
    }
    events.push(event);
  }
  return events;
}

/**
 * An OpenAI Responses `compaction` output item. Its encrypted content is an
 * opaque carry-over for the next request and is never read.
 */
function compactionItemEvents(payload: Bag): EventAttributes[] {
  const output = member(payload, "output");
  if (!Array.isArray(output)) return [];
  const events: EventAttributes[] = [];
  for (const raw of output) {
    const item = asBag(raw);
    if (member(item, "type") !== "compaction") continue;
    const event = providerEvent(RIUS_COMPACTION_KIND_SUMMARIZE);
    const id = text(member(item, "id"));
    if (id !== undefined) event[RIUS_COMPACTION_ID] = id;
    events.push(event);
  }
  return events;
}

/**
 * The compactions an LLM span's provider response reports, as event
 * attributes, or nothing.
 *
 * The payload is read like `responseIdFromOutput` reads it: an LLM span whose
 * `output.value`, undeclared or declared JSON, is a string starting with `{`.
 * A streamed response is recorded by the instrumentors as its accumulated
 * text (`text/plain`), which carries none of this, so a stream reports no
 * compaction. The payload is the provider's and untrusted: every member is
 * read as an own property, and a field of the wrong type is left out rather
 * than guessed.
 */
export function providerCompactions(
  attributes: Readonly<Record<string, AttributeValue | undefined>>,
): EventAttributes[] {
  if (attributes[OPENINFERENCE_SPAN_KIND] !== SpanKind.LLM) return [];
  const mime = attributes["output.mime_type"];
  if (mime !== undefined && mime !== "application/json") return [];
  const output = attributes[OUTPUT_VALUE];
  if (typeof output !== "string" || !output.startsWith("{")) return [];
  // Most responses are no compaction, and the body can be large: do not parse
  // what cannot hold one.
  if (!output.includes("context_management") && !output.includes("compaction")) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  const payload = asBag(parsed);
  if (payload === undefined) return [];
  return [
    ...contextEditingEvents(payload),
    ...compactionBlockEvents(payload),
    ...compactionItemEvents(payload),
  ];
}

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
 */
export function addProviderCompactions(
  span: ReadableSpan,
  attributes: Record<string, AttributeValue | undefined>,
): void {
  const events = span.events;
  if (!Array.isArray(events)) return;
  if (events.some((event) => event.name === RIUS_COMPACTION_EVENT)) return;
  const found = providerCompactions(attributes);
  if (found.length === 0) return;
  const time = span.endTime ?? span.startTime ?? [0, 0];
  for (const event of found) {
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
 */
export function markNextLlmSpanCompacted(): void {
  let flag = pendingFlag.getStore();
  if (flag === undefined) {
    flag = { pending: false };
    pendingFlag.enterWith(flag);
  }
  flag.pending = true;
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
 * Unlike the session and user ids it never reaches a pending snapshot: the key
 * is not on the identity allowlist, since it is learned from a call the
 * producer made, not from the request, and it is only ever set at start on a
 * span that is already an LLM span or at end.
 */
export class CompactionFlagSpanProcessor implements SpanProcessor {
  private readonly undecided = new WeakMap<object, PendingFlag>();

  onStart(span: Span, _parentContext: Context): void {
    const flag = pendingFlag.getStore();
    if (flag === undefined || !flag.pending) return;
    if (!isKnown(span.attributes)) {
      this.undecided.set(span, flag);
      return;
    }
    if (!isLlmSpan(span.attributes)) return;
    flag.pending = false;
    span.setAttribute(GEN_AI_CONVERSATION_COMPACTED, true);
  }

  onEnd(span: ReadableSpan): void {
    const flag = this.undecided.get(span);
    if (flag === undefined) return;
    this.undecided.delete(span);
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
