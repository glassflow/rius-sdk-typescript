import { context, ROOT_CONTEXT, type Span, SpanKind, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  ParentBasedSampler,
  SamplingDecision,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { DuplicateProviderSpanSampler } from "../src/nativeProviderSpans.js";
import { GEN_AI_PROVIDER_NAME } from "../src/semconv.js";

// The Anthropic SDK (0.134 and later) starts a CLIENT span of its own for each
// API call; under the OpenInference Anthropic instrumentation that span is a
// second LLM span for the same call. These pin which spans the sampler drops.

const OI_SCOPE = "@arizeai/openinference-instrumentation-anthropic";
const NATIVE_SCOPE = "com.anthropic.sdk.typescript";
const PROVIDER = { [GEN_AI_PROVIDER_NAME]: "anthropic" };

function setup() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    sampler: new DuplicateProviderSpanSampler(new ParentBasedSampler({ root: alwaysOn })),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { exporter, tracer: (scope: string) => provider.getTracer(scope) };
}

const alwaysOn = {
  shouldSample: () => ({ decision: SamplingDecision.RECORD_AND_SAMPLED }),
  toString: () => "on",
};

/** OpenInference puts its span in the context wrapped, as `OISpan` does. */
function oiContext(span: Span) {
  const wrapped = { span, config: {}, spanContext: () => span.spanContext() };
  return trace.setSpan(ROOT_CONTEXT, wrapped as unknown as Span);
}

describe("the provider SDK's own span under an OpenInference Anthropic span", () => {
  it("is dropped, with its descendants, and the OpenInference span is kept", () => {
    const { exporter, tracer } = setup();
    const oi = tracer(OI_SCOPE).startSpan("Anthropic Messages");
    for (const ctx of [oiContext(oi), trace.setSpan(ROOT_CONTEXT, oi)]) {
      const native = tracer(NATIVE_SCOPE).startSpan(
        "anthropic.messages.create",
        { kind: SpanKind.CLIENT, attributes: PROVIDER },
        ctx,
      );
      expect(native.isRecording()).toBe(false);
      // An HTTP attempt span under it follows it out, rather than losing its parent.
      const attempt = tracer("http").startSpan(
        "POST",
        { kind: SpanKind.CLIENT },
        trace.setSpan(ctx, native),
      );
      expect(attempt.isRecording()).toBe(false);
      attempt.end();
      native.end();
    }
    oi.end();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["Anthropic Messages"]);
  });

  it("is kept when no OpenInference Anthropic span records the call", () => {
    const { exporter, tracer } = setup();
    const parent = tracer("rius").startSpan("agent");
    context.with(trace.setSpan(ROOT_CONTEXT, parent), () => {
      tracer(NATIVE_SCOPE)
        .startSpan("anthropic.messages.create", { kind: SpanKind.CLIENT, attributes: PROVIDER })
        .end();
    });
    tracer(NATIVE_SCOPE)
      .startSpan("anthropic.messages.create", { kind: SpanKind.CLIENT, attributes: PROVIDER })
      .end();
    parent.end();
    expect(exporter.getFinishedSpans()).toHaveLength(3);
  });

  it("keeps other spans under an OpenInference Anthropic span", () => {
    const { exporter, tracer } = setup();
    const oi = tracer(OI_SCOPE).startSpan("Anthropic Messages");
    const ctx = oiContext(oi);
    // An HTTP span with no provider name (an SDK without native tracing).
    tracer("http").startSpan("POST", { kind: SpanKind.CLIENT }, ctx).end();
    // A provider-named span that is not a CLIENT call.
    tracer("x").startSpan("inner", { attributes: PROVIDER }, ctx).end();
    oi.end();
    expect(exporter.getFinishedSpans()).toHaveLength(3);
  });

  it("never throws into startSpan, whatever sits in the context", () => {
    const { tracer } = setup();
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    );
    const ctx = trace.setSpan(ROOT_CONTEXT, hostile as unknown as Span);
    const sampler = new DuplicateProviderSpanSampler({
      shouldSample: () => ({ decision: SamplingDecision.RECORD_AND_SAMPLED }),
    });
    expect(
      sampler.shouldSample(ctx, `${"0".repeat(31)}1`, "x", SpanKind.CLIENT, PROVIDER, []).decision,
    ).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(() =>
      tracer(NATIVE_SCOPE).startSpan("y", { kind: SpanKind.CLIENT }, ROOT_CONTEXT),
    ).not.toThrow();
  });
});
