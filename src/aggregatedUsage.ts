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
