import { type Attributes, type Context, type Link, SpanKind, trace } from "@opentelemetry/api";
import { type Sampler, SamplingDecision, type SamplingResult } from "@opentelemetry/sdk-trace-base";
import { GEN_AI_PROVIDER_NAME } from "./semconv.js";

/**
 * Keeps one LLM span per Anthropic call when the provider SDK traces itself.
 *
 * From 0.134, `@anthropic-ai/sdk` starts a CLIENT span of its own for every
 * API call whenever a global tracer provider is registered, which Rius does.
 * Under the OpenInference Anthropic instrumentation, that span is a child of
 * the instrumentation's LLM span for the same call: two LLM spans per call,
 * the inner one carrying the API body's error type (`not_found_error`) as
 * `error.type`, and none of the attributes Rius adds to the outer one.
 *
 * The OpenInference span is the one Rius builds on, so the SDK's span is
 * dropped here at creation: NOT_RECORD, which also drops its descendants
 * through ParentBased sampling, so nothing is left without a parent. A call
 * the instrumentation does not wrap has no OpenInference parent and keeps its
 * native span. On SDK versions without native tracing nothing matches.
 */

/** The instrumentation scope of the OpenInference Anthropic instrumentation's spans. */
const OPENINFERENCE_ANTHROPIC_SCOPE = "@arizeai/openinference-instrumentation-anthropic";

type Scoped = { instrumentationScope?: { name?: unknown } };

/**
 * The instrumentation scope name of the span active in `context`, if it has
 * one. OpenInference puts its spans in the context wrapped (an `OISpan` that
 * holds the SDK span as `span`), so one level of wrapping is looked through.
 */
function parentScope(context: Context): string | undefined {
  const parent = trace.getSpan(context) as (Scoped & { span?: Scoped }) | undefined;
  const name = (parent?.instrumentationScope ?? parent?.span?.instrumentationScope)?.name;
  return typeof name === "string" ? name : undefined;
}

/**
 * Whether a span about to start is the provider SDK's own span for a call the
 * OpenInference Anthropic instrumentation is already recording: a CLIENT span
 * naming a GenAI provider from its start, directly under that instrumentation's span.
 */
export function isDuplicateProviderSpan(
  context: Context,
  spanKind: SpanKind,
  attributes: Attributes,
): boolean {
  return (
    spanKind === SpanKind.CLIENT &&
    typeof attributes[GEN_AI_PROVIDER_NAME] === "string" &&
    parentScope(context) === OPENINFERENCE_ANTHROPIC_SCOPE
  );
}

/** Drops {@link isDuplicateProviderSpan} spans, and defers every other decision to `inner`. */
export class DuplicateProviderSpanSampler implements Sampler {
  private readonly inner: Sampler;

  constructor(inner: Sampler) {
    this.inner = inner;
  }

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    let duplicate = false;
    try {
      duplicate = isDuplicateProviderSpan(context, spanKind, attributes ?? {});
    } catch {
      // This runs inside the caller's startSpan(): an exotic parent must
      // never turn into an exception there. Keep the span instead.
    }
    if (duplicate) return { decision: SamplingDecision.NOT_RECORD };
    return this.inner.shouldSample(context, traceId, spanName, spanKind, attributes, links);
  }

  toString(): string {
    return `DuplicateProviderSpan{${this.inner.toString()}}`;
  }
}
