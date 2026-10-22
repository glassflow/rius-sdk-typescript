import { ROOT_CONTEXT, SpanKind, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type Span,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { NativeProviderSpanDemoter } from "../src/nativeProviderSpans.js";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_USAGE_INPUT_TOKENS,
} from "../src/semconv.js";

// The Anthropic SDK (0.134 and later) traces each API call itself. With the
// OpenInference Anthropic instrumentation enabled, its chat span repeats the
// instrumentation's LLM span; these pin what the demoter takes off it and
// which spans it leaves alone.

const NATIVE_SCOPE = "com.anthropic.sdk.typescript";
const CHAT = {
  [GEN_AI_OPERATION_NAME]: "chat",
  [GEN_AI_PROVIDER_NAME]: "anthropic",
  [GEN_AI_REQUEST_MODEL]: "claude-test",
  "http.route": "/v1/messages",
};

function setup(enabled: boolean) {
  const demoter = new NativeProviderSpanDemoter();
  if (enabled) demoter.enable();
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [demoter, new SimpleSpanProcessor(exporter)],
  });
  const finished = (name: string): ReadableSpan | undefined =>
    exporter.getFinishedSpans().find((s) => s.name === name);
  return { demoter, finished, tracer: (scope: string) => provider.getTracer(scope) };
}

/** A chat span as the SDK makes one: model and route at start, usage once the reply is read. */
function nativeCall(tracer: ReturnType<typeof setup>["tracer"]) {
  const span = tracer(NATIVE_SCOPE).startSpan("anthropic.messages.create", {
    kind: SpanKind.CLIENT,
    attributes: CHAT,
  });
  const attributesAtStart = { ...(span as unknown as ReadableSpan).attributes };
  // The application's HTTP instrumentation, under the call span.
  tracer("http")
    .startSpan("POST", { kind: SpanKind.CLIENT }, trace.setSpan(ROOT_CONTEXT, span))
    .end();
  span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, 5);
  span.setAttribute("http.response.status_code", 200);
  span.end();
  return { span, attributesAtStart };
}

describe("the Anthropic SDK's chat span, with the OpenInference instrumentation enabled", () => {
  it("is demoted from its start: no LLM operation, model or usage, but still a CLIENT span", () => {
    const { finished, tracer } = setup(true);
    const { attributesAtStart } = nativeCall(tracer);
    expect(attributesAtStart).toEqual({
      [GEN_AI_PROVIDER_NAME]: "anthropic",
      "http.route": "/v1/messages",
    });
    const span = finished("anthropic.messages.create");
    expect(span?.kind).toBe(SpanKind.CLIENT);
    expect(span?.attributes).toEqual({
      [GEN_AI_PROVIDER_NAME]: "anthropic",
      "http.route": "/v1/messages",
      "http.response.status_code": 200,
    });
  });

  it("keeps the HTTP span under it, parented to it", () => {
    const { finished, tracer } = setup(true);
    const { span } = nativeCall(tracer);
    expect(finished("POST")?.parentSpanContext?.spanId).toBe(span.spanContext().spanId);
  });

  // The Bedrock and Vertex clients (@anthropic-ai/bedrock-sdk and
  // @anthropic-ai/vertex-sdk 1.x) call through the same patched Messages
  // resource, so OpenInference records their calls too; their own spans carry
  // the platform as a scope suffix and their own provider name.
  it.each([
    ["com.anthropic.sdk.typescript.bedrock", "aws.bedrock"],
    ["com.anthropic.sdk.typescript.vertex", "gcp.vertex_ai"],
  ])("is demoted from the %s scope too", (scope, provider) => {
    const { finished, tracer } = setup(true);
    tracer(scope)
      .startSpan("anthropic.messages.create", {
        kind: SpanKind.CLIENT,
        attributes: { ...CHAT, [GEN_AI_PROVIDER_NAME]: provider },
      })
      .end();
    expect(finished("anthropic.messages.create")?.attributes).toEqual({
      [GEN_AI_PROVIDER_NAME]: provider,
      "http.route": "/v1/messages",
    });
  });

  it("keeps the conversation id, which is neither content nor what the backend counts by", () => {
    const { finished, tracer } = setup(true);
    tracer(NATIVE_SCOPE)
      .startSpan("anthropic.messages.create", {
        attributes: { ...CHAT, "gen_ai.conversation.id": "thread_1" },
      })
      .end();
    expect(finished("anthropic.messages.create")?.attributes["gen_ai.conversation.id"]).toBe(
      "thread_1",
    );
  });

  it("leaves the SDK's tool runner spans, which have no OpenInference counterpart", () => {
    const { finished, tracer } = setup(true);
    for (const operation of ["execute_tool", "invoke_agent"]) {
      tracer(NATIVE_SCOPE)
        .startSpan(operation, { attributes: { [GEN_AI_OPERATION_NAME]: operation } })
        .end();
      expect(finished(operation)?.attributes[GEN_AI_OPERATION_NAME]).toBe(operation);
    }
  });

  it("leaves chat spans from any other scope", () => {
    const { finished, tracer } = setup(true);
    tracer("@arizeai/openinference-instrumentation-anthropic")
      .startSpan("Anthropic Messages", { attributes: CHAT })
      .end();
    expect(finished("Anthropic Messages")?.attributes).toEqual(CHAT);
  });
});

describe("the Anthropic SDK's chat span, without the OpenInference instrumentation", () => {
  it("stays the call's LLM span", () => {
    const { finished, tracer } = setup(false);
    nativeCall(tracer);
    expect(finished("anthropic.messages.create")?.attributes).toMatchObject({
      ...CHAT,
      [GEN_AI_USAGE_INPUT_TOKENS]: 5,
    });
  });
});

describe("a span the demoter cannot read", () => {
  it("never throws into span creation", () => {
    const { demoter } = setup(true);
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    ) as Span;
    expect(() => demoter.onStart(hostile, ROOT_CONTEXT)).not.toThrow();
  });

  it("never throws into span end, for a span it took at start", () => {
    const { demoter } = setup(true);
    // A chat span whose attribute bag cannot be listed: taken at start, then
    // unreadable at both hooks.
    const attributes = new Proxy(
      { [GEN_AI_OPERATION_NAME]: "chat" },
      {
        ownKeys() {
          throw new Error("boom");
        },
      },
    );
    const span = { instrumentationScope: { name: NATIVE_SCOPE }, attributes } as unknown as Span;
    expect(() => demoter.onStart(span, ROOT_CONTEXT)).not.toThrow();
    expect(() => demoter.onEnd(span)).not.toThrow();
  });
});
