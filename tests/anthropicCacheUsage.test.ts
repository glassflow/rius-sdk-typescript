import http from "node:http";
import { createRequire } from "node:module";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import {
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
} from "../src/semconv.js";

// Prompt-cache usage through the auto-instrumented Anthropic client, end to
// end: a real Anthropic client, instrumented by the OpenInference package
// init() enables, against a local server that reports cache reads and writes.
//
// Anthropic reports `input_tokens` EXCLUSIVE of the cached tokens. Before
// @arizeai/openinference-instrumentation-anthropic 0.2.7 the instrumentor
// copied that number as the prompt count and never read the two cache fields,
// so a mostly-cached call was priced on its few uncached tokens alone. This
// file pins the peer floor: it fails on any version that drops the cache.
//
// A file of its own: the OpenInference packages keep module-level patch state,
// and vitest's per-file module isolation keeps that state to this file.

const require = createRequire(import.meta.url);

interface AnthropicClient {
  messages: {
    create(body: unknown): Promise<AsyncIterable<unknown> | { content: unknown[] }>;
  };
}

// Required before init(), as most applications load them.
const Anthropic = (
  require("@anthropic-ai/sdk") as {
    default: new (options: {
      apiKey: string;
      baseURL: string;
      maxRetries: number;
    }) => AnthropicClient;
  }
).default;

const USAGE = {
  input_tokens: 2,
  cache_creation_input_tokens: 1000,
  cache_read_input_tokens: 5520,
  output_tokens: 7,
};

const REPLY = {
  id: "msg_cache",
  type: "message",
  role: "assistant",
  model: "claude-test",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: USAGE,
};

/** The server-sent events of the same reply, streamed as the Messages API streams it. */
function streamBody(): string {
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          ...REPLY,
          content: [],
          stop_reason: null,
          usage: { ...USAGE, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: USAGE.output_tokens },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

/** Answers a streaming request with SSE and any other with the JSON reply. */
async function cacheServer(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if ((JSON.parse(body) as { stream?: boolean }).stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(streamBody());
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(REPLY));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

let exporter: InMemorySpanExporter;
let rius: RiusClient;
let server: { url: string; close: () => void };
let anthropic: AnthropicClient;

beforeAll(async () => {
  exporter = new InMemorySpanExporter();
  rius = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
  expect(await rius.ready).toContain("anthropic");
  server = await cacheServer();
  anthropic = new Anthropic({ apiKey: "not-a-real-key", baseURL: server.url, maxRetries: 0 });
});

afterAll(async () => {
  server.close();
  await rius.shutdown();
});

async function llmSpan(call: () => Promise<unknown>): Promise<ReadableSpan | undefined> {
  exporter.reset();
  await call();
  await rius.flush();
  return exporter.getFinishedSpans().find((s) => s.attributes["openinference.span.kind"] === "LLM");
}

const REQUEST = {
  model: "claude-test",
  max_tokens: 16,
  system: [
    { type: "text", text: "a long cached system prompt", cache_control: { type: "ephemeral" } },
  ],
  messages: [{ role: "user", content: "hi" }],
};

// The input count is the whole prompt, cached tokens included, which is how
// the conventions and the backend's pricing read gen_ai.usage.input_tokens.
const EXPECTED = {
  [GEN_AI_USAGE_INPUT_TOKENS]: 2 + 1000 + 5520,
  [GEN_AI_USAGE_OUTPUT_TOKENS]: 7,
  [GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: 5520,
  [GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS]: 1000,
};

describe("an auto-instrumented Anthropic call that hits the prompt cache", () => {
  it("records the cache reads and writes, and counts them in the input tokens", async () => {
    const span = await llmSpan(() => anthropic.messages.create(REQUEST));
    expect(span).toBeDefined();
    expect(span?.attributes).toMatchObject(EXPECTED);
  });

  it("does the same for a streamed call", async () => {
    const span = await llmSpan(async () => {
      const stream = (await anthropic.messages.create({
        ...REQUEST,
        stream: true,
      })) as AsyncIterable<unknown>;
      for await (const _event of stream) {
        // Drained: the instrumentor ends the span when the stream completes.
      }
    });
    expect(span).toBeDefined();
    expect(span?.attributes).toMatchObject(EXPECTED);
  });
});
