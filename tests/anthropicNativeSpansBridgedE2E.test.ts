import { context, propagation, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, type RiusClient } from "../src/client.js";
import { GEN_AI_OPERATION_NAME, GEN_AI_REQUEST_MODEL } from "../src/semconv.js";
import {
  Anthropic,
  type AnthropicClient,
  callsFor,
  expectOneLlmCall,
  isNative,
  messagesServer,
  TRACES_ITSELF,
} from "./anthropicMessages.js";

// The same calls as anthropicNativeSpansE2E, with another SDK holding the
// OpenTelemetry global and Rius bridged onto it (bridgeForeignProvider). The
// OpenInference span comes from Rius's own provider; the Anthropic SDK's span
// from the global, the other provider, and reaches Rius's pipeline only as a
// copy. It must be demoted there all the same, and the other provider's span
// left exactly as that SDK made it.
//
// A file of its own: the OpenInference packages keep module-level patch state,
// and vitest's per-file module isolation keeps that state to this file.

let foreign: NodeTracerProvider;
let foreignExporter: InMemorySpanExporter;
let exporter: InMemorySpanExporter;
let rius: RiusClient;
let server: { url: string; close: () => void };
let anthropic: AnthropicClient;

beforeAll(async () => {
  foreignExporter = new InMemorySpanExporter();
  foreign = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(foreignExporter)] });
  foreign.register();
  exporter = new InMemorySpanExporter();
  rius = init({
    spanExporter: exporter,
    heartbeat: false,
    bridgeForeignProvider: true,
  });
  expect(await rius.ready).toContain("anthropic");
  server = await messagesServer();
  anthropic = new Anthropic({ apiKey: "not-a-real-key", baseURL: server.url, maxRetries: 0 });
});

afterAll(async () => {
  server.close();
  await rius.shutdown();
  await foreign.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

async function spansOf(call: () => Promise<unknown>): Promise<ReadableSpan[]> {
  exporter.reset();
  foreignExporter.reset();
  await call();
  await rius.flush();
  return exporter.getFinishedSpans();
}

describe("one Anthropic call, with Rius bridged onto another provider", () => {
  it.each(callsFor(() => anthropic))("is one LLM call through %s", async (_name, call) => {
    expectOneLlmCall(await spansOf(call));
    // The other provider's own span is untouched: Rius demotes its copy.
    const theirs = foreignExporter.getFinishedSpans().filter(isNative);
    expect(theirs).toHaveLength(TRACES_ITSELF ? 1 : 0);
    for (const span of theirs) {
      expect(span.attributes[GEN_AI_OPERATION_NAME]).toBe("chat");
      expect(span.attributes[GEN_AI_REQUEST_MODEL]).toBe("claude-test");
    }
  });
});
