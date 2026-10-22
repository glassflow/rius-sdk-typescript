import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, type RiusClient } from "../src/client.js";
import {
  Anthropic,
  type AnthropicClient,
  callsFor,
  expectOneLlmCall,
  isNative,
  messagesServer,
  REPLY_TEXT,
  REQUEST,
  TRACES_ITSELF,
} from "./anthropicMessages.js";

// Every way to make one Anthropic Messages call, through a real client that
// the OpenInference package init() enables instruments, against a local
// server. From 0.134 the Anthropic SDK also traces each call itself: as a
// child of the instrumentation's span for create(), as a sibling for stream().
// Either way the call must reach the backend as ONE LLM call with one priced
// model and usage, and the SDK's own span as a plain CLIENT span.
//
// A file of its own: the OpenInference packages keep module-level patch state,
// and vitest's per-file module isolation keeps that state to this file.

let exporter: InMemorySpanExporter;
let rius: RiusClient;
let server: { url: string; close: () => void };
let anthropic: AnthropicClient;

beforeAll(async () => {
  exporter = new InMemorySpanExporter();
  rius = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
  expect(await rius.ready).toContain("anthropic");
  server = await messagesServer();
  anthropic = new Anthropic({ apiKey: "not-a-real-key", baseURL: server.url, maxRetries: 0 });
});

afterAll(async () => {
  server.close();
  await rius.shutdown();
});

async function spansOf(call: () => Promise<unknown>): Promise<ReadableSpan[]> {
  exporter.reset();
  await call();
  await rius.flush();
  return exporter.getFinishedSpans();
}

describe("one Anthropic call", () => {
  it.each(callsFor(() => anthropic))("is one LLM call through %s", async (_name, call) => {
    expectOneLlmCall(await spansOf(call));
  });

  it.runIf(TRACES_ITSELF)(
    "leaves no prompt or reply on the SDK's span, even in the SDK's content mode",
    async () => {
      const recording = new Anthropic({
        apiKey: "not-a-real-key",
        baseURL: server.url,
        maxRetries: 0,
        openTelemetry: { traces: { contentMode: "content" } },
      });
      const spans = await spansOf(() =>
        recording.messages.create({
          ...REQUEST,
          system: "SYSTEM-TEXT",
          messages: [{ role: "user", content: "PROMPT-TEXT" }],
        }),
      );
      const native = spans.filter(isNative);
      expect(native).toHaveLength(1);
      const text = JSON.stringify(native[0].attributes);
      for (const content of ["SYSTEM-TEXT", "PROMPT-TEXT", REPLY_TEXT]) {
        expect(text).not.toContain(content);
      }
    },
  );
});

describe("after shutdown() and a fresh init()", () => {
  it("still makes one Anthropic call one LLM call", async () => {
    await rius.shutdown();
    // shutdown() shut the old exporter down too, and it exports nothing more.
    exporter = new InMemorySpanExporter();
    rius = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
    expect(await rius.ready).toContain("anthropic");
    // A client made after the new init(), as an application restarting its
    // tracing would; one made before keeps the tracer it was built with.
    const fresh = new Anthropic({ apiKey: "not-a-real-key", baseURL: server.url, maxRetries: 0 });
    for (const [, call] of callsFor(() => fresh)) {
      expectOneLlmCall(await spansOf(call));
    }
  });
});
