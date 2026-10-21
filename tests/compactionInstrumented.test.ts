import http from "node:http";
import { createRequire } from "node:module";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, type RiusClient } from "../src/client.js";
import { markCompaction } from "../src/markCompaction.js";
import {
  GEN_AI_CONVERSATION_COMPACTED,
  RIUS_COMPACTION_EVENT,
  RIUS_COMPACTION_EXECUTOR,
  RIUS_COMPACTION_ID,
  RIUS_COMPACTION_KIND,
  RIUS_COMPACTION_SUMMARY_TEXT,
  RIUS_COMPACTION_TOKENS_AFTER,
  RIUS_COMPACTION_TOKENS_BEFORE,
  RIUS_COMPACTION_TOKENS_DROPPED,
} from "../src/semconv.js";

// Compactions through the real auto-instrumented clients: the Anthropic and
// OpenAI SDKs, instrumented by the OpenInference packages init() enables,
// against a local server that answers with the provider's compaction data.
// Pins that the span carries its LLM kind at start, which the marker flag
// needs, and that the response body is what the instrumentors record.
//
// A file of its own: the OpenInference packages keep module-level patch state,
// and vitest's per-file module isolation keeps that state to this file.

const require = createRequire(import.meta.url);

interface Sdk {
  messages?: { create(body: unknown): Promise<unknown> };
  responses?: { create(body: unknown): Promise<unknown> };
}

// Required before init(), as most applications load them.
const Anthropic = (
  require("@anthropic-ai/sdk") as {
    default: new (o: { apiKey: string; baseURL: string; maxRetries: number }) => Sdk;
  }
).default;
const OpenAI = (
  require("openai") as {
    OpenAI: new (o: { apiKey: string; baseURL: string; maxRetries: number }) => Sdk;
  }
).OpenAI;

const SUMMARY = "SUMMARY-OF-THE-CONVERSATION";

const ANTHROPIC_REPLY = {
  id: "msg_c",
  type: "message",
  role: "assistant",
  model: "claude-test",
  content: [
    { type: "compaction", content: SUMMARY },
    { type: "text", text: "ok" },
  ],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 10,
    output_tokens: 3,
    iterations: [
      { type: "compaction", input_tokens: 9000, output_tokens: 100 },
      { type: "message", input_tokens: 10, output_tokens: 3 },
    ],
  },
  context_management: {
    applied_edits: [
      { type: "clear_tool_uses_20250919", cleared_tool_uses: 4, cleared_input_tokens: 2000 },
    ],
  },
};

const OPENAI_REPLY = {
  id: "resp_c",
  object: "response",
  created_at: 1,
  status: "completed",
  model: "gpt-test",
  output: [
    { type: "compaction", id: "cmp_1", encrypted_content: "OPAQUE-BLOB" },
    {
      type: "message",
      id: "msg_1",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    },
  ],
  usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
};

// Whether the provider reports a compaction in its replies.
let compacting = true;

/** The reply of a provider that did not compact: the same message, no compaction data. */
function plainReply(reply: typeof ANTHROPIC_REPLY | typeof OPENAI_REPLY): unknown {
  if ("context_management" in reply) {
    const { context_management: _edits, ...rest } = reply;
    return { ...rest, content: reply.content.filter((b) => b.type !== "compaction") };
  }
  return { ...reply, output: reply.output.filter((i) => i.type !== "compaction") };
}

/** Answers a Responses request with the OpenAI reply and any other with the Anthropic one. */
async function provider(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const reply = request.url?.includes("/responses") ? OPENAI_REPLY : ANTHROPIC_REPLY;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(compacting ? reply : plainReply(reply)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

let exporter: InMemorySpanExporter;
let rius: RiusClient;
let mock: { url: string; close: () => void };
let anthropic: Sdk;
let openai: Sdk;

beforeAll(async () => {
  exporter = new InMemorySpanExporter();
  rius = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
  const attached = await rius.ready;
  expect(attached).toContain("anthropic");
  expect(attached).toContain("openai");
  mock = await provider();
  anthropic = new Anthropic({ apiKey: "not-a-real-key", baseURL: mock.url, maxRetries: 0 });
  openai = new OpenAI({ apiKey: "not-a-real-key", baseURL: mock.url, maxRetries: 0 });
});

afterAll(async () => {
  mock.close();
  await rius.shutdown();
});

async function llmSpan(call: () => Promise<unknown>): Promise<ReadableSpan | undefined> {
  exporter.reset();
  await call();
  await rius.flush();
  return exporter.getFinishedSpans().find((s) => s.attributes["openinference.span.kind"] === "LLM");
}

const ANTHROPIC_REQUEST = {
  model: "claude-test",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
};

describe("provider compactions on an auto-instrumented call", () => {
  it("records Anthropic context editing and a compaction block", async () => {
    const span = await llmSpan(
      () => anthropic.messages?.create(ANTHROPIC_REQUEST) as Promise<unknown>,
    );
    const events = (span?.events ?? []).filter((e) => e.name === RIUS_COMPACTION_EVENT);
    expect(events.map((e) => e.attributes?.[RIUS_COMPACTION_KIND])).toEqual([
      "clear_tool_results",
      "summarize",
    ]);
    expect(events[0].attributes?.[RIUS_COMPACTION_TOKENS_DROPPED]).toBe(2000);
    expect(events[1].attributes).toMatchObject({
      [RIUS_COMPACTION_EXECUTOR]: "provider",
      [RIUS_COMPACTION_TOKENS_BEFORE]: 9000,
      [RIUS_COMPACTION_TOKENS_AFTER]: 10,
      [RIUS_COMPACTION_SUMMARY_TEXT]: SUMMARY,
    });
    expect(span?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
  });

  it("records an OpenAI Responses compaction item without its encrypted content", async () => {
    const span = await llmSpan(
      () => openai.responses?.create({ model: "gpt-test", input: "hi" }) as Promise<unknown>,
    );
    const events = (span?.events ?? []).filter((e) => e.name === RIUS_COMPACTION_EVENT);
    expect(events).toHaveLength(1);
    expect(events[0].attributes).toMatchObject({
      [RIUS_COMPACTION_KIND]: "summarize",
      [RIUS_COMPACTION_EXECUTOR]: "provider",
      [RIUS_COMPACTION_ID]: "cmp_1",
    });
    expect(JSON.stringify(events)).not.toContain("OPAQUE-BLOB");
    expect(span?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
  });

  it("flags the next real call after markCompaction, and only that one", async () => {
    await new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        (async () => {
          compacting = false;
          markCompaction({ summary: "s" });
          const first = await llmSpan(
            () => anthropic.messages?.create(ANTHROPIC_REQUEST) as Promise<unknown>,
          );
          expect(first?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
          const second = await llmSpan(
            () => openai.responses?.create({ model: "gpt-test", input: "hi" }) as Promise<unknown>,
          );
          expect(second?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
          compacting = true;
        })().then(resolve, reject);
      });
    });
  });
});
