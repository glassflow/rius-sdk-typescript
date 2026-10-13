import { type AttributeValue, SpanKind as OtelSpanKind, type Tracer } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_USAGE_PREFIX,
  RIUS_AGGREGATED_USAGE_PREFIX,
  SpanKind,
  operationForKind,
} from "./semconv.js";

/**
 * Some producers report a whole agent run's token usage on their invoke_agent
 * span AND each model call's usage on that call's own chat span. The GenAI
 * conventions allow both, but the tokens are then on the wire twice under
 * `gen_ai.usage.*`, and every backend sum over those keys counts them twice.
 *
 * Which spans carry an aggregate cannot be told from a span on its own: an
 * invoke_agent span may equally be the only record of its usage (a producer
 * that never instruments the individual calls). So this applies only to
 * producers KNOWN to repeat the usage on per-call spans, and they are known by
 * the tracer they were handed: spans started through `aggregatingTracer` are
 * remembered here and nowhere else, so nothing about the mark reaches the wire.
 */
const fromAggregatingProducer = new WeakSet<object>();

const INVOKE_AGENT = operationForKind(SpanKind.AGENT);

/**
 * `tracer`, remembering every span started through it as one from a producer
 * that reports aggregate usage on its invoke_agent spans.
 */
export function aggregatingTracer(tracer: Tracer): Tracer {
  return {
    startSpan(...args: Parameters<Tracer["startSpan"]>) {
      const span = tracer.startSpan(...args);
      fromAggregatingProducer.add(span);
      return span;
    },
    // Tracer.startActiveSpan is overloaded on where the callback sits, but it
    // is always the last argument, so it is wrapped there and every other
    // argument is passed through untouched.
    startActiveSpan(...args: unknown[]) {
      const last = args.length - 1;
      const callback = args[last] as (span: object) => unknown;
      args[last] = (span: object) => {
        fromAggregatingProducer.add(span);
        return callback(span);
      };
      return (tracer.startActiveSpan as (...forwarded: unknown[]) => unknown)(...args);
    },
  } as Tracer;
}

/**
 * Moves every `gen_ai.usage.*` key to `rius.aggregated_usage.*` on an
 * aggregating producer's in-process invoke_agent span, in place, at onEnd.
 *
 * Must run AFTER the normalization table, so a legacy usage spelling has
 * already become its canonical key and moves under the name the backend reads.
 *
 * CLIENT invoke_agent spans keep their usage: they invoke a remote agent whose
 * model calls are not in this trace, so their usage is the only record of it.
 */
export function moveAggregatedUsage(
  span: ReadableSpan,
  attributes: Record<string, AttributeValue | undefined>,
): void {
  if (!fromAggregatingProducer.has(span)) return;
  if (span.kind !== OtelSpanKind.INTERNAL) return;
  if (attributes[GEN_AI_OPERATION_NAME] !== INVOKE_AGENT) return;
  for (const key of Object.keys(attributes)) {
    if (!key.startsWith(GEN_AI_USAGE_PREFIX)) continue;
    const value = attributes[key];
    delete attributes[key];
    if (value === undefined) continue;
    attributes[RIUS_AGGREGATED_USAGE_PREFIX + key.slice(GEN_AI_USAGE_PREFIX.length)] = value;
  }
}

/**
 * A wrapper's span repeats the usage its provider call already recorded.
 *
 * LangChain's chat models call their provider's client, so with both
 * instrumentations enabled (the SDK enables every one it finds) each model call
 * is recorded twice: on LangChain's `ChatOpenAI` span and on the openai
 * instrumentation's span, its child, both carrying the call's usage. The child
 * is the call itself, so it keeps the usage; the wrapper's copy moves to
 * `rius.aggregated_usage.*`, as for an aggregating producer above.
 *
 * Decided by end order, never by guessing: a child ends before its parent, so
 * by the time a wrapper span ends it is already known whether an LLM child with
 * usage ended under it. A wrapper with no such child (a LangChain model whose
 * provider is not instrumented) keeps its usage: it is the only record of the
 * call. A LangChain chain span above the model span is marked too, and has no
 * usage to move.
 *
 * The provider span is a child only because `langchainSpanContext` runs the
 * model call under LangChain's span; the instrumentation never makes its spans
 * current on its own.
 */
export const WRAPPER_SCOPES: ReadonlySet<string> = new Set([
  "@arizeai/openinference-instrumentation-langchain",
]);

/**
 * Upper bound on the spans remembered at once. A wrapper normally leaves the
 * books when it ends, milliseconds after its child; the bound only protects a
 * process whose wrappers never end. The oldest entry goes first.
 */
const MAX_TRACKED = 10_000;

const openWrappers = new Map<string, true>();
const markedWrappers = new Map<string, true>();

interface SpanIds {
  spanContext(): { traceId: string; spanId: string };
}

function idOf(span: SpanIds): string {
  const { traceId, spanId } = span.spanContext();
  return `${traceId}/${spanId}`;
}

function remember(books: Map<string, true>, id: string): void {
  books.delete(id);
  books.set(id, true);
  while (books.size > MAX_TRACKED) {
    const oldest = books.keys().next().value;
    if (oldest === undefined) break;
    books.delete(oldest);
  }
}

/** At onStart: note a span started by an instrumentation that wraps calls. */
export function noteWrapperStart(
  span: SpanIds & { instrumentationScope?: { name: string } },
): void {
  const scope = span.instrumentationScope?.name;
  if (scope === undefined || !WRAPPER_SCOPES.has(scope)) return;
  remember(openWrappers, idOf(span));
}

function hasUsage(attributes: Record<string, AttributeValue | undefined>): boolean {
  return Object.keys(attributes).some(
    (key) => key.startsWith(GEN_AI_USAGE_PREFIX) && attributes[key] !== undefined,
  );
}

/**
 * At onEnd, after normalization: a span ending with usage under an open
 * wrapper marks the wrapper; a marked wrapper's own usage moves aside.
 */
export function moveWrappedCallUsage(
  span: ReadableSpan,
  attributes: Record<string, AttributeValue | undefined>,
): void {
  // Nothing open: no wrapper to mark or to move (the common case).
  if (openWrappers.size === 0 && markedWrappers.size === 0) return;
  const parent = span.parentSpanContext;
  if (parent !== undefined && hasUsage(attributes)) {
    const parentId = `${parent.traceId}/${parent.spanId}`;
    if (openWrappers.has(parentId)) remember(markedWrappers, parentId);
  }
  const id = idOf(span);
  openWrappers.delete(id);
  if (!markedWrappers.delete(id)) return;
  for (const key of Object.keys(attributes)) {
    if (!key.startsWith(GEN_AI_USAGE_PREFIX)) continue;
    const value = attributes[key];
    delete attributes[key];
    if (value === undefined) continue;
    attributes[RIUS_AGGREGATED_USAGE_PREFIX + key.slice(GEN_AI_USAGE_PREFIX.length)] = value;
  }
}
