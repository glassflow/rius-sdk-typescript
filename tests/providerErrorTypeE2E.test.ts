import http from "node:http";
import { createRequire } from "node:module";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { observe } from "../src/observe.js";
import { EXCEPTION_EVENT, EXCEPTION_TYPE, SpanKind } from "../src/semconv.js";

// A provider failure end to end: a real provider client, auto-instrumented by
// the OpenInference package init() enables, called inside an `observe` AGENT
// root, against a local server that answers 404. Both spans must name the
// provider's error class, not the generic "Error" its SDK leaves in err.name.
//
// A file of its own: the OpenInference packages keep module-level patch state,
// and vitest's per-file module isolation keeps that state to this file.

const require = createRequire(import.meta.url);

interface Clients {
  Anthropic: new (options: { apiKey: string; baseURL: string; maxRetries: number }) => {
    messages: { create(body: unknown): Promise<unknown> };
  };
  OpenAI: new (options: { apiKey: string; baseURL: string; maxRetries: number }) => {
    chat: { completions: { create(body: unknown): Promise<unknown> } };
  };
}

// Required before init(), as most applications load them.
const clients: Clients = {
  Anthropic: (require("@anthropic-ai/sdk") as { default: Clients["Anthropic"] }).default,
  OpenAI: (require("openai") as { OpenAI: Clients["OpenAI"] }).OpenAI,
};

/** Answers every request with 404 and the given error body. */
async function notFoundServer(body: unknown): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

let exporter: InMemorySpanExporter;
let client: RiusClient;

beforeAll(async () => {
  exporter = new InMemorySpanExporter();
  client = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
  const enabled = await client.ready;
  expect(enabled).toEqual(expect.arrayContaining(["anthropic", "openai"]));
});

afterAll(async () => {
  await client.shutdown();
});

async function failInsideAgent(call: () => Promise<unknown>): Promise<ReadableSpan[]> {
  exporter.reset();
  const agent = observe(call, { name: "agent", kind: SpanKind.AGENT });
  await expect(agent()).rejects.toThrow();
  await client.flush();
  return exporter.getFinishedSpans();
}

function exceptionType(span: ReadableSpan | undefined): unknown {
  return span?.events.find((e) => e.name === EXCEPTION_EVENT)?.attributes?.[EXCEPTION_TYPE];
}

describe("a provider 404", () => {
  it("names anthropic.NotFoundError on the auto-instrumented span and the agent root", async () => {
    const server = await notFoundServer({
      type: "error",
      error: { type: "not_found_error", message: "model: claude-nope-1" },
    });
    try {
      const anthropic = new clients.Anthropic({
        apiKey: "not-a-real-key",
        baseURL: server.url,
        maxRetries: 0,
      });
      const spans = await failInsideAgent(() =>
        anthropic.messages.create({
          model: "claude-nope-1",
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      const llm = spans.find((s) => s.attributes["openinference.span.kind"] === "LLM");
      const root = spans.find((s) => s.name === "agent");
      expect(llm).toBeDefined();
      expect(llm?.attributes["error.type"]).toBe("anthropic.NotFoundError");
      expect(exceptionType(llm)).toBe("anthropic.NotFoundError");
      expect(root?.attributes["error.type"]).toBe("anthropic.NotFoundError");
      expect(exceptionType(root)).toBe("anthropic.NotFoundError");
    } finally {
      server.close();
    }
  });

  it("names openai.NotFoundError on the auto-instrumented span and the agent root, not the body's error code", async () => {
    const server = await notFoundServer({
      error: { message: "no such model", type: "invalid_request_error", code: "model_not_found" },
    });
    try {
      const openai = new clients.OpenAI({
        apiKey: "not-a-real-key",
        baseURL: server.url,
        maxRetries: 0,
      });
      const spans = await failInsideAgent(() =>
        openai.chat.completions.create({
          model: "gpt-nope",
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      // The instrumentation alone leaves a rejected call's span open; the
      // SDK's guard ends it (see withRejectedCallsEnded), so the span gets the
      // same assertions as the Anthropic case.
      const llm = spans.find((s) => s.attributes["openinference.span.kind"] === "LLM");
      expect(llm).toBeDefined();
      expect(llm?.attributes["error.type"]).toBe("openai.NotFoundError");
      expect(exceptionType(llm)).toBe("openai.NotFoundError");
      const root = spans.find((s) => s.name === "agent");
      expect(root?.attributes["error.type"]).toBe("openai.NotFoundError");
      expect(exceptionType(root)).toBe("openai.NotFoundError");
    } finally {
      server.close();
    }
  });

  it("still records a plain Error as Error", async () => {
    const spans = await failInsideAgent(async () => {
      throw new Error("x");
    });
    const root = spans.find((s) => s.name === "agent");
    expect(root?.attributes["error.type"]).toBe("Error");
    expect(exceptionType(root)).toBe("Error");
  });
});
