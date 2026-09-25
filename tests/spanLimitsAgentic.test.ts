import http from "node:http";
import { createRequire } from "node:module";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { NormalizingSpanProcessor } from "../src/normalize.js";
import {
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_TOOL_DEFINITIONS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
} from "../src/semconv.js";

// A realistic agent loop end to end: a real OpenAI client, auto-instrumented
// by the OpenInference package init() enables, sending a 20-turn tool-using
// conversation with 10 tools to a local server. OpenInference writes one
// attribute per message field and per tool field, so this one span carries
// several hundred attributes; under OpenTelemetry's default limit of 128 the
// span refused the NEWEST ones — usage, the output and the finish reason.
//
// A file of its own: the OpenInference packages keep module-level patch state,
// and vitest's per-file module isolation keeps that state to this file.

const require = createRequire(import.meta.url);

interface OpenAIClient {
  chat: { completions: { create(body: unknown): Promise<unknown> } };
}
const OpenAI = (
  require("openai") as {
    OpenAI: new (options: { apiKey: string; baseURL: string; maxRetries: number }) => OpenAIClient;
  }
).OpenAI;

const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "gpt-4o-2024-08-06",
  choices: [
    {
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_x", type: "function", function: { name: "tool_0", arguments: '{"q":"x"}' } },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230 },
};

async function completionServer(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(COMPLETION));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

const TOOLS = Array.from({ length: 10 }, (_, i) => ({
  type: "function",
  function: {
    name: `tool_${i}`,
    description: `tool number ${i}`,
    parameters: { type: "object", properties: { q: { type: "string" } } },
  },
}));

/** A system prompt, then `turns` of user / tool call / tool result / answer. */
function agenticConversation(turns: number): unknown[] {
  const messages: unknown[] = [{ role: "system", content: "You are a helpful agent." }];
  for (let t = 0; t < turns; t++) {
    messages.push({ role: "user", content: `question ${t}` });
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: `call_${t}`, type: "function", function: { name: "tool_0", arguments: "{}" } },
      ],
    });
    messages.push({ role: "tool", tool_call_id: `call_${t}`, content: `result ${t}` });
    messages.push({ role: "assistant", content: `answer ${t}` });
  }
  messages.push({ role: "user", content: "next" });
  return messages;
}

let exporter: InMemorySpanExporter;
let client: RiusClient;
let server: { url: string; close: () => void };

beforeAll(async () => {
  server = await completionServer();
  exporter = new InMemorySpanExporter();
  client = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
  expect(await client.ready).toContain("openai");
});

afterAll(async () => {
  await client.shutdown();
  server.close();
});

describe("a 20-turn agentic OpenInference span", () => {
  it("keeps usage, the output, the model and the tools", async () => {
    const openai = new OpenAI({ apiKey: "not-a-real-key", baseURL: server.url, maxRetries: 0 });
    await openai.chat.completions.create({
      model: "gpt-4o",
      messages: agenticConversation(20),
      tools: TOOLS,
      temperature: 0.2,
    });
    await client.flush();
    const llm = exporter
      .getFinishedSpans()
      .find((s) => s.attributes["openinference.span.kind"] === "LLM");
    expect(llm).toBeDefined();
    const attributes = (llm as ReadableSpan).attributes;

    expect(llm?.droppedAttributesCount).toBe(0);
    expect(attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(1200);
    expect(attributes[GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(30);
    expect(attributes[GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(["tool_calls"]);
    expect(attributes[GEN_AI_REQUEST_MODEL]).toBe("gpt-4o");
    // No provider assertion: the OpenAI instrumentation writes llm.system, not
    // llm.provider, and llm.system is deliberately unmapped (see normalize.ts).
    expect(attributes["output.value"]).toBeDefined();

    const output = JSON.parse(attributes[GEN_AI_OUTPUT_MESSAGES] as string);
    expect(output).toHaveLength(1);
    expect(output[0].role).toBe("assistant");
    // Every one of the 82 input messages made it, not a truncated prefix.
    expect(JSON.parse(attributes[GEN_AI_INPUT_MESSAGES] as string)).toHaveLength(82);
    expect(JSON.parse(attributes[GEN_AI_TOOL_DEFINITIONS] as string)).toHaveLength(10);
  });
});

describe("a source whose canonical write the span limit refuses at start", () => {
  it("is kept, so the end-of-span pass still maps it", async () => {
    const spans = new InMemorySpanExporter();
    // Three keys fill the span; the canonical provider written at onStart is
    // then a fourth and is refused.
    const provider = new BasicTracerProvider({
      spanLimits: { attributeCountLimit: 3 },
      spanProcessors: [new NormalizingSpanProcessor(), new SimpleSpanProcessor(spans)],
    });
    const span = provider.getTracer("t").startSpan("llm", {
      attributes: { "app.a": 1, "app.b": 2, "llm.provider": "openai" },
    });
    span.end();
    const [finished] = spans.getFinishedSpans();
    expect(finished?.attributes[GEN_AI_PROVIDER_NAME]).toBe("openai");
    expect(finished?.attributes["llm.provider"]).toBeUndefined();
    await provider.shutdown();
  });

  it("is still consumed when its target lands", async () => {
    const spans = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new NormalizingSpanProcessor(), new SimpleSpanProcessor(spans)],
    });
    const span = provider.getTracer("t").startSpan("llm", {
      attributes: { "llm.provider": "openai" },
    });
    // Consumed at start already, not only at end.
    expect((span as unknown as ReadableSpan).attributes["llm.provider"]).toBeUndefined();
    span.end();
    const [finished] = spans.getFinishedSpans();
    expect(finished?.attributes[GEN_AI_PROVIDER_NAME]).toBe("openai");
    await provider.shutdown();
  });
});
