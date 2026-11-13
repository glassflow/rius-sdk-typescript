import { type AttributeValue, SpanKind as OtelSpanKind } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { serializeMessages } from "./messages.js";
import {
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OPERATION_NAME,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_TOOL_CALL_ARGUMENTS,
  GEN_AI_TOOL_CALL_RESULT,
  GEN_AI_TOOL_NAME,
  GEN_AI_USAGE_PREFIX,
  OPENINFERENCE_SPAN_KIND,
  operationForKind,
  RIUS_AGGREGATED_USAGE_PREFIX,
  SpanKind,
} from "./semconv.js";

/**
 * TanStack AI's `otelMiddleware` (`@tanstack/ai/middlewares/otel`) traces one
 * `chat()` call as a run span, a span for each model call under it, and a span
 * for each tool execution. The app hands the middleware a tracer of its own
 * choosing, so nothing in the instrumentation scope names the producer: its
 * spans are known by the `tanstack.ai.*` keys only it writes.
 *
 * What is mapped, in place, at onEnd:
 *
 * - The run span is an agent run (`invoke_agent`): it owns a loop of model
 *   calls and tool executions, as the Vercel AI SDK's generate and stream
 *   wrappers do. Its usage is the sum of its model calls', which their own
 *   spans report again, so it moves to `rius.aggregated_usage.*` and each call
 *   is counted once.
 * - A tool span is a tool execution (`execute_tool`). The middleware records
 *   the arguments and the result as one-message lists; they become
 *   `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`.
 * - The spans of the media activities (image, speech, transcription and the
 *   like) are left as the middleware wrote them: nothing marks a finished one
 *   as TanStack's.
 * - Messages are `{role, content}` objects; they are rewritten in the GenAI
 *   `{role, parts}` schema. The run span has its input and output only under
 *   the Langfuse keys the middleware mirrors them to.
 * - The `langfuse.*` mirrors go: each repeats a message list the span now
 *   carries under the conventions' key. So do the message events on a model
 *   call's span, which repeat the same messages a third time, in the event
 *   shape the conventions have since replaced. Their text is under a bare
 *   `content` key, which the privacy controls do not know as content: left on
 *   the span, a prompt would leave the process with `captureContent: false`.
 *
 * Every canonical key already on the span wins, so what an app sets through
 * the middleware's `attributeEnricher` is kept.
 *
 * Source spellings throughout, read from `@tanstack/ai` 1.4.0
 * (`dist/esm/middlewares/otel.js`) and spelled inline: the registry names none
 * of them.
 */

/** Set on a model call's span when it starts: the call's index in the run. */
const TANSTACK_ITERATION = "tanstack.ai.iteration";
/** Set on the run span when the run finishes: how many model calls it made. */
const TANSTACK_ITERATIONS = "tanstack.ai.iterations";
/**
 * Set when a run is cancelled, on every span the middleware closes for it: the
 * run span, the model call in flight and each tool span still open. A media
 * generation that is cancelled gets it too.
 */
const TANSTACK_COMPLETION_REASON = "tanstack.ai.completion.reason";
/**
 * Set on a tool span when the tool returns or throws. A tool span closed
 * because its run was cancelled or failed has none.
 */
const TANSTACK_TOOL_OUTCOME = "tanstack.ai.tool.outcome";

const LANGFUSE_OBSERVATION_INPUT = "langfuse.observation.input";
const LANGFUSE_OBSERVATION_OUTPUT = "langfuse.observation.output";
const LANGFUSE_TRACE_INPUT = "langfuse.trace.input";
const LANGFUSE_TRACE_OUTPUT = "langfuse.trace.output";

/**
 * The events the middleware adds to a model call's span when it captures
 * content: one for each message sent, named for the message's role, and one
 * for the answer.
 */
const TANSTACK_MESSAGE_EVENT = /^gen_ai\.(?:choice|.+\.message)$/;

const INVOKE_AGENT = operationForKind(SpanKind.AGENT);
const EXECUTE_TOOL = operationForKind(SpanKind.TOOL);

type Bag = Record<string, AttributeValue | undefined>;

/**
 * Upper bound on the run spans remembered at once. A run leaves the books when
 * it ends; the bound only protects a process whose runs never end. The oldest
 * entry goes first.
 */
const MAX_TRACKED = 10_000;

/**
 * The spans a TanStack model call ended under. A run that failed or was
 * cancelled never gets `tanstack.ai.iterations`, but its model calls still
 * reported their usage and it still repeats it, so the run is also known by
 * its children: a child ends before its parent.
 */
const runs = new Map<string, true>();

/**
 * The model calls that ended under a run still on the books, each with its
 * run. A tool span is parented by the model call that asked for the tool, and
 * when a run fails the middleware ends that model call before the tool spans
 * it closes, which then carry no key of TanStack's own: they are known by
 * their parent.
 */
const calls = new Map<string, string>();

function idOf(span: ReadableSpan): string {
  const { traceId, spanId } = span.spanContext();
  return `${traceId}/${spanId}`;
}

function dropOldest(book: Map<string, unknown>): void {
  while (book.size > MAX_TRACKED) {
    const oldest = book.keys().next().value;
    if (oldest === undefined) break;
    book.delete(oldest);
  }
}

function rememberCall(id: string, run: string): void {
  runs.delete(run);
  runs.set(run, true);
  dropOldest(runs);
  calls.set(id, run);
  dropOldest(calls);
}

/** Take a run off the books, with its model calls. True when it was on them. */
function forgetRun(id: string): boolean {
  if (!runs.delete(id)) return false;
  for (const [call, run] of calls) if (run === id) calls.delete(call);
  return true;
}

function parseList(value: AttributeValue | undefined): unknown[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fill `target` with the first of `sources` that holds a message list,
 * rewritten in the GenAI schema, unless the span already has it. A source that
 * cannot be read is left where it is, whole.
 */
function mapMessages(
  attributes: Bag,
  target: string,
  sources: readonly string[],
  defaultRole: string,
): void {
  for (const source of sources) {
    if (attributes[target] !== undefined && source !== target) break;
    const messages = parseList(attributes[source]);
    if (messages === undefined) continue;
    attributes[target] = serializeMessages(messages, defaultRole);
    break;
  }
}

/** Drop each Langfuse mirror of a message list the span has under `target`. */
function dropMirrors(attributes: Bag, target: string, mirrors: readonly string[]): void {
  if (attributes[target] === undefined) return;
  for (const mirror of mirrors) delete attributes[mirror];
}

/**
 * The content of a tool span's one-message list: `[{role: "tool", content}]`.
 * Anything else is not the middleware's shape and is left alone.
 */
function toolPayload(value: AttributeValue | undefined): string | undefined {
  const messages = parseList(value);
  if (messages === undefined || messages.length !== 1) return undefined;
  const message = messages[0];
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : undefined;
}

function mapToolPayload(attributes: Bag, target: string, source: string, mirror: string): void {
  const payload = toolPayload(attributes[source]);
  if (payload === undefined) return;
  attributes[target] ??= payload;
  delete attributes[source];
  delete attributes[mirror];
}

/**
 * Name the span, unless the app's enricher already did. The operation is only
 * filled in beside the kind it belongs to: a span the app gave another kind
 * does not get this one's operation.
 */
function setKind(attributes: Bag, kind: SpanKind, operation: string | undefined): void {
  attributes[OPENINFERENCE_SPAN_KIND] ??= kind;
  if (operation !== undefined && attributes[OPENINFERENCE_SPAN_KIND] === kind) {
    attributes[GEN_AI_OPERATION_NAME] ??= operation;
  }
}

function normalizeRun(attributes: Bag): void {
  setKind(attributes, SpanKind.AGENT, INVOKE_AGENT);
  // The run repeats its calls' usage whatever the app's enricher named it, so
  // the move does not depend on the kind or the operation.
  for (const key of Object.keys(attributes)) {
    if (!key.startsWith(GEN_AI_USAGE_PREFIX)) continue;
    const value = attributes[key];
    delete attributes[key];
    const target = RIUS_AGGREGATED_USAGE_PREFIX + key.slice(GEN_AI_USAGE_PREFIX.length);
    if (value !== undefined && attributes[target] === undefined) attributes[target] = value;
  }
  mapMessages(
    attributes,
    GEN_AI_INPUT_MESSAGES,
    [GEN_AI_INPUT_MESSAGES, LANGFUSE_OBSERVATION_INPUT, LANGFUSE_TRACE_INPUT],
    "user",
  );
  mapMessages(
    attributes,
    GEN_AI_OUTPUT_MESSAGES,
    [GEN_AI_OUTPUT_MESSAGES, LANGFUSE_OBSERVATION_OUTPUT, LANGFUSE_TRACE_OUTPUT],
    "assistant",
  );
  dropMirrors(attributes, GEN_AI_INPUT_MESSAGES, [
    LANGFUSE_OBSERVATION_INPUT,
    LANGFUSE_TRACE_INPUT,
  ]);
  dropMirrors(attributes, GEN_AI_OUTPUT_MESSAGES, [
    LANGFUSE_OBSERVATION_OUTPUT,
    LANGFUSE_TRACE_OUTPUT,
  ]);
}

/** Drop the message events, in place: `events` is the span's own array. */
function dropMessageEvents(span: ReadableSpan): void {
  const events = span.events as { name: string }[] | undefined;
  if (events === undefined) return;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event !== undefined && TANSTACK_MESSAGE_EVENT.test(event.name)) events.splice(index, 1);
  }
}

function normalizeModelCall(attributes: Bag): void {
  mapMessages(attributes, GEN_AI_INPUT_MESSAGES, [GEN_AI_INPUT_MESSAGES], "user");
  mapMessages(attributes, GEN_AI_OUTPUT_MESSAGES, [GEN_AI_OUTPUT_MESSAGES], "assistant");
  dropMirrors(attributes, GEN_AI_INPUT_MESSAGES, [LANGFUSE_OBSERVATION_INPUT]);
  dropMirrors(attributes, GEN_AI_OUTPUT_MESSAGES, [LANGFUSE_OBSERVATION_OUTPUT]);
}

function normalizeTool(attributes: Bag): void {
  setKind(attributes, SpanKind.TOOL, EXECUTE_TOOL);
  mapToolPayload(
    attributes,
    GEN_AI_TOOL_CALL_ARGUMENTS,
    GEN_AI_INPUT_MESSAGES,
    LANGFUSE_OBSERVATION_INPUT,
  );
  mapToolPayload(
    attributes,
    GEN_AI_TOOL_CALL_RESULT,
    GEN_AI_OUTPUT_MESSAGES,
    LANGFUSE_OBSERVATION_OUTPUT,
  );
}

/**
 * Map a TanStack AI span onto the conventions, in place, at onEnd; see the
 * note at the top of this file. A span from any other producer is left as it
 * is.
 *
 * Must run AFTER the normalization table, so the provider and a legacy usage
 * spelling are already under their canonical keys.
 */
export function normalizeTanstackSpan(span: ReadableSpan, attributes: Bag): void {
  const parent = span.parentSpanContext;
  if (attributes[TANSTACK_ITERATION] !== undefined) {
    if (parent !== undefined) rememberCall(idOf(span), `${parent.traceId}/${parent.spanId}`);
    normalizeModelCall(attributes);
    dropMessageEvents(span);
    return;
  }
  const cancelled = attributes[TANSTACK_COMPLETION_REASON] !== undefined;
  if (attributes[TANSTACK_TOOL_OUTCOME] !== undefined) {
    normalizeTool(attributes);
    return;
  }
  if (attributes[GEN_AI_TOOL_NAME] !== undefined) {
    // A tool span the middleware closed without an outcome, because its run
    // was cancelled or failed under it. Any other span that names a tool is
    // another producer's.
    const underCall =
      calls.size > 0 && parent !== undefined && calls.has(`${parent.traceId}/${parent.spanId}`);
    if (cancelled || underCall) normalizeTool(attributes);
    return;
  }
  // The books hold a run from its first model call until it ends, and a run
  // whose stream was abandoned for good. While they are empty, a span of any
  // other producer stops at the lookups below without its id being read.
  const hadModelCalls = runs.size > 0 && forgetRun(idOf(span));
  // A cancelled media generation carries the cancellation key too: it is a
  // client span with an operation of its own, and no run.
  const cancelledRun = cancelled && span.kind !== OtelSpanKind.CLIENT;
  if (hadModelCalls || cancelledRun || attributes[TANSTACK_ITERATIONS] !== undefined) {
    normalizeRun(attributes);
  }
}
