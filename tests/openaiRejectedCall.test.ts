import http from "node:http";
import { createRequire } from "node:module";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { REGISTRY } from "../src/instrumentation.js";
import { observe } from "../src/observe.js";
import { ERROR_TYPE, EXCEPTION_EVENT, EXCEPTION_TYPE, SpanKind } from "../src/semconv.js";

// A REJECTED OpenAI call, auto-instrumented by the OpenInference package
// init() enables. The instrumentation (4.2.1 through 4.2.7) ends its span on a
// synchronous throw or a resolved call only, so without the SDK's guard a
// failed call exports no LLM span at all and its trace reads as a success.
// A real OpenAI client against a local server; no network.
//
// A file of its own: the OpenInference packages keep module-level patch state,
// and vitest's per-file module isolation keeps that state to this file.

const require = createRequire(import.meta.url);

interface OpenAIClient {
  chat: { completions: { create(body: unknown): Promise<unknown> } };
  completions: { create(body: unknown): Promise<unknown> };
  embeddings: { create(body: unknown): Promise<unknown> };
  responses: { create(body: unknown): Promise<unknown> };
}
interface OpenAIModule {
  OpenAI: new (options: { apiKey: string; baseURL: string; maxRetries: number }) => OpenAIClient;
  NotFoundError: new (...args: never[]) => Error;
}

// Required before init(), as most applications load it.
const openaiModule = require("openai") as OpenAIModule;
const chatPrototype = (
  openaiModule.OpenAI as unknown as { Chat: { Completions: { prototype: { create: unknown } } } }
).Chat.Completions.prototype;
// The provider's own method, before anything patched it.
const pristineCreate = chatPrototype.create;

type Reply = { status: number; body: unknown };

/** Answers every request with whatever `reply()` returns at the time. */
async function server(reply: () => Reply): Promise<{ url: string; close: () => void }> {
  const srv = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const { status, body } = reply();
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const address = srv.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  return { url: `http://127.0.0.1:${address.port}`, close: () => srv.close() };
}

const NOT_FOUND: Reply = {
  status: 404,
  body: {
    error: { message: "no such model", type: "invalid_request_error", code: "model_not_found" },
  },
};

let reply: Reply = NOT_FOUND;
let exporter: InMemorySpanExporter;
let client: RiusClient;
let mock: { url: string; close: () => void };
let openai: OpenAIClient;

beforeAll(async () => {
  mock = await server(() => reply);
  exporter = new InMemorySpanExporter();
  client = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
  expect(await client.ready).toContain("openai");
  openai = new openaiModule.OpenAI({ apiKey: "not-a-real-key", baseURL: mock.url, maxRetries: 0 });
});

afterAll(async () => {
  await client.shutdown();
  mock.close();
});

/** Runs `call` inside an AGENT root, expecting it to reject; returns the exported spans. */
async function failInsideAgent(call: () => Promise<unknown>): Promise<{
  spans: ReadableSpan[];
  error: unknown;
}> {
  exporter.reset();
  reply = NOT_FOUND;
  let error: unknown;
  const agent = observe(
    async () => {
      try {
        return await call();
      } catch (e) {
        error = e;
        throw e;
      }
    },
    { name: "agent", kind: SpanKind.AGENT },
  );
  await expect(agent()).rejects.toThrow();
  await client.flush();
  return { spans: exporter.getFinishedSpans(), error };
}

function llmSpan(spans: ReadableSpan[]): ReadableSpan | undefined {
  return spans.find((s) => s.attributes["openinference.span.kind"] === "LLM");
}

function embeddingSpan(spans: ReadableSpan[]): ReadableSpan | undefined {
  return spans.find((s) => s.attributes["openinference.span.kind"] === "EMBEDDING");
}

function assertFailed(span: ReadableSpan | undefined): void {
  expect(span).toBeDefined();
  expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  expect(span?.status.message).toContain("no such model");
  const exceptions = span?.events.filter((e) => e.name === EXCEPTION_EVENT) ?? [];
  expect(exceptions).toHaveLength(1);
  expect(exceptions[0]?.attributes?.[EXCEPTION_TYPE]).toBe("openai.NotFoundError");
  expect(span?.attributes[ERROR_TYPE]).toBe("openai.NotFoundError");
}

describe("a rejected auto-instrumented OpenAI call", () => {
  it("ends the chat completions span as an ERROR naming openai.NotFoundError", async () => {
    const { spans, error } = await failInsideAgent(() =>
      openai.chat.completions.create({
        model: "gpt-does-not-exist",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    // The caller still gets the provider's own error, untouched.
    expect(error).toBeInstanceOf(openaiModule.NotFoundError);
    const llm = llmSpan(spans);
    assertFailed(llm);
    // Still a child of the agent root, which records the failure too.
    const root = spans.find((s) => s.name === "agent");
    expect(llm?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    expect(root?.attributes[ERROR_TYPE]).toBe("openai.NotFoundError");
  });

  it("ends a streaming chat completions span that fails before its first chunk", async () => {
    const { spans } = await failInsideAgent(() =>
      openai.chat.completions.create({
        model: "gpt-does-not-exist",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    assertFailed(llmSpan(spans));
  });

  it("ends the responses API span", async () => {
    const { spans } = await failInsideAgent(() =>
      openai.responses.create({ model: "gpt-does-not-exist", input: "hi" }),
    );
    assertFailed(llmSpan(spans));
  });

  it("ends a streaming responses API span", async () => {
    const { spans } = await failInsideAgent(() =>
      openai.responses.create({ model: "gpt-does-not-exist", input: "hi", stream: true }),
    );
    assertFailed(llmSpan(spans));
  });

  it("ends the embeddings span", async () => {
    const { spans } = await failInsideAgent(() =>
      openai.embeddings.create({ model: "text-embedding-nope", input: "hi" }),
    );
    assertFailed(embeddingSpan(spans));
  });

  it("ends the legacy completions span", async () => {
    const { spans } = await failInsideAgent(() =>
      openai.completions.create({ model: "gpt-does-not-exist", prompt: "hi" }),
    );
    assertFailed(llmSpan(spans));
  });
});

describe("a successful call is untouched", () => {
  it("parses the response once and ends the span OK, with no exception", async () => {
    exporter.reset();
    reply = {
      status: 200,
      body: {
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "gpt-4o-2024-08-06",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "hello" },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      },
    };
    const result = (await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    })) as { choices: Array<{ message: { content: string } }> };
    expect(result.choices[0]?.message.content).toBe("hello");
    await client.flush();
    const llm = llmSpan(exporter.getFinishedSpans());
    expect(llm?.status.code).toBe(SpanStatusCode.OK);
    expect(llm?.events.filter((e) => e.name === EXCEPTION_EVENT)).toHaveLength(0);
    expect(llm?.attributes[ERROR_TYPE]).toBeUndefined();
  });
});

describe("a module the instrumentation has already patched", () => {
  it("is not guarded a second time, so the caller's own span is never ended", async () => {
    // A second load patches the same cached build again. The instrumentation
    // declines to re-wrap it, so a guard installed for it would sit ON TOP of
    // the instrumentation's wrapper, where the active span is the caller's.
    const entry = REGISTRY.find((e) => e.name === "openai");
    await entry?.load();
    reply = NOT_FOUND;
    const outer = trace.getTracer("test").startSpan("outer");
    await expect(
      context.with(trace.setSpan(context.active(), outer), () =>
        openai.chat.completions.create({
          model: "gpt-does-not-exist",
          messages: [{ role: "user", content: "hi" }],
        }),
      ),
    ).rejects.toThrow();
    expect(outer.isRecording()).toBe(true);
    outer.end();
  });
});

describe("shutdown and re-init", () => {
  it("leaves the provider's own method behind, and guards again after re-init", async () => {
    await client.shutdown();
    expect(chatPrototype.create).toBe(pristineCreate);

    exporter = new InMemorySpanExporter();
    client = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
    expect(await client.ready).toContain("openai");
    const { spans } = await failInsideAgent(() =>
      openai.chat.completions.create({
        model: "gpt-does-not-exist",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    assertFailed(llmSpan(spans));
  });
});
