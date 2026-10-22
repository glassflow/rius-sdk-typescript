import http from "node:http";
import { createRequire } from "node:module";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, type RiusClient } from "../src/client.js";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_USAGE_INPUT_TOKENS,
  OPENINFERENCE_SPAN_KIND,
} from "../src/semconv.js";

// Every way to make one Anthropic Messages call, through a real client that
// the OpenInference package init() enables instruments, against a local
// server. From 0.134 the Anthropic SDK also traces each call itself: as a
// child of the instrumentation's span for create(), as a sibling for stream().
// Either way the call must reach the backend as ONE LLM call with one priced
// model and usage, and the SDK's own span as a plain CLIENT span.
//
// A file of its own: the OpenInference packages keep module-level patch state,
// and vitest's per-file module isolation keeps that state to this file.

const require = createRequire(import.meta.url);

interface MessageStream {
  finalMessage(): Promise<unknown>;
}

interface Messages {
  create(body: unknown): Promise<unknown>;
  stream(body: unknown): MessageStream;
}

interface AnthropicClient {
  messages: Messages;
  beta: { messages: Messages };
}

// Required before init(), as most applications load them.
const Anthropic = (
  require("@anthropic-ai/sdk") as {
    default: new (options: {
      apiKey: string;
      baseURL: string;
      maxRetries: number;
      // From 0.134; older clients ignore it.
      openTelemetry?: { traces: { contentMode: "content" | "metadata_only" } };
    }) => AnthropicClient;
  }
).default;

const SDK_VERSION = (require("@anthropic-ai/sdk/version") as { VERSION: string }).VERSION;
const [MAJOR, MINOR] = SDK_VERSION.split(".").map(Number);
/** Whether the installed SDK traces its own calls (0.134 and later). */
const TRACES_ITSELF = MAJOR > 0 || MINOR >= 134;

const USAGE = { input_tokens: 5, output_tokens: 1 };

const REPLY = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-test",
  content: [{ type: "text", text: "REPLY-TEXT" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: USAGE,
};
const REPLY_TEXT = "REPLY-TEXT";

function streamBody(): string {
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      { type: "message_start", message: { ...REPLY, content: [], stop_reason: null } },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: REPLY_TEXT } },
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

async function messagesServer(): Promise<{ url: string; close: () => void }> {
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

async function drain(stream: unknown): Promise<void> {
  for await (const _event of stream as AsyncIterable<unknown>) {
    // Drained, as a caller would.
  }
}

const REQUEST = {
  model: "claude-test",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
};

const CALLS: Array<[string, () => Promise<unknown>]> = [
  ["messages.create", () => anthropic.messages.create(REQUEST)],
  [
    "messages.create with stream: true",
    async () => drain(await anthropic.messages.create({ ...REQUEST, stream: true })),
  ],
  ["messages.stream", () => anthropic.messages.stream(REQUEST).finalMessage()],
  ["beta.messages.create", () => anthropic.beta.messages.create(REQUEST)],
  ["beta.messages.stream", () => anthropic.beta.messages.stream(REQUEST).finalMessage()],
];

/**
 * How argus-core reads a span, as of its main branch: the sink derives
 * openinference.span.kind from gen_ai.operation.name when only the operation
 * is set (normalize.kindByOperation), the console badges a span by that kind,
 * else as llm when it has gen_ai.request.model (spans.spanKindExpr), and
 * enrich.costFor prices any span with gen_ai.request.model and at least one
 * of the four token counts, whatever its kind. A change to those rules should
 * break this, so the demotion is revisited with it.
 */
const LLM_OPERATIONS = new Set(["chat", "text_completion", "generate_content", "decide"]);
const PRICED_COUNTS = [
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.cache_read.input_tokens",
  "gen_ai.usage.cache_write.input_tokens",
];

function backendView(span: ReadableSpan): { badge: string; priced: boolean } {
  const a = span.attributes;
  const operation = a[GEN_AI_OPERATION_NAME];
  const kind =
    a[OPENINFERENCE_SPAN_KIND] ??
    (typeof operation === "string" && LLM_OPERATIONS.has(operation) ? "LLM" : undefined);
  const model = a[GEN_AI_REQUEST_MODEL];
  const badge =
    typeof kind === "string" && kind !== ""
      ? kind.toLowerCase()
      : typeof model === "string" && model !== ""
        ? "llm"
        : "other";
  const priced =
    typeof model === "string" && model !== "" && PRICED_COUNTS.some((k) => a[k] !== undefined);
  return { badge, priced };
}

describe("one Anthropic call", () => {
  it.each(CALLS)("is one LLM call through %s", async (_name, call) => {
    const spans = await spansOf(call);
    const llm = spans.filter((s) => s.attributes[OPENINFERENCE_SPAN_KIND] === "LLM");
    expect(llm.map((s) => s.instrumentationScope.name)).toEqual([
      "@arizeai/openinference-instrumentation-anthropic",
    ]);
    // What the backend classes and prices a call by: one model, one usage.
    expect(spans.filter((s) => s.attributes[GEN_AI_REQUEST_MODEL] !== undefined)).toHaveLength(1);
    expect(spans.filter((s) => s.attributes[GEN_AI_USAGE_INPUT_TOKENS] !== undefined)).toHaveLength(
      1,
    );

    const native = spans.filter((s) => s.instrumentationScope.name.startsWith("com.anthropic.sdk"));
    expect(native).toHaveLength(TRACES_ITSELF ? 1 : 0);
    for (const span of native) {
      // Demoted, not dropped: still the call's CLIENT span, with its HTTP facts.
      const genAi = Object.keys(span.attributes).filter((k) => k.startsWith("gen_ai."));
      expect(genAi).toEqual([GEN_AI_PROVIDER_NAME]);
      expect(span.attributes[OPENINFERENCE_SPAN_KIND]).toBeUndefined();
      expect(span.attributes["http.response.status_code"]).toBe(200);
      expect(backendView(span)).toEqual({ badge: "other", priced: false });
    }
    expect(llm.map(backendView)).toEqual([{ badge: "llm", priced: true }]);
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
      const native = spans.filter((s) =>
        s.instrumentationScope.name.startsWith("com.anthropic.sdk"),
      );
      expect(native).toHaveLength(1);
      const text = JSON.stringify(native[0].attributes);
      for (const content of ["SYSTEM-TEXT", "PROMPT-TEXT", REPLY_TEXT]) {
        expect(text).not.toContain(content);
      }
    },
  );
});
