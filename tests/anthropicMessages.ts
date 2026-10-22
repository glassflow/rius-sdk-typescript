import http from "node:http";
import { createRequire } from "node:module";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { expect } from "vitest";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_USAGE_INPUT_TOKENS,
  OPENINFERENCE_SPAN_KIND,
} from "../src/semconv.js";

// Shared by the end-to-end tests of Anthropic Messages calls: a local server
// that answers like the Messages API, every way to make one call, and what a
// call must look like to the backend once Rius has exported it.

const require = createRequire(import.meta.url);

interface MessageStream {
  finalMessage(): Promise<unknown>;
}

interface Messages {
  create(body: unknown): Promise<unknown>;
  stream(body: unknown): MessageStream;
}

export interface AnthropicClient {
  messages: Messages;
  beta: { messages: Messages };
}

// Required when this module loads, which is before a test file's init(), as
// most applications load the SDK.
export const Anthropic = (
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
export const TRACES_ITSELF = MAJOR > 0 || MINOR >= 134;

export const REPLY_TEXT = "REPLY-TEXT";

const USAGE = { input_tokens: 5, output_tokens: 1 };

const REPLY = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-test",
  content: [{ type: "text", text: REPLY_TEXT }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: USAGE,
};

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

/** Answers a streaming request with server-sent events and any other with the JSON reply. */
export async function messagesServer(): Promise<{ url: string; close: () => void }> {
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

export const REQUEST = {
  model: "claude-test",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
};

async function drain(stream: unknown): Promise<void> {
  for await (const _event of stream as AsyncIterable<unknown>) {
    // Drained, as a caller would.
  }
}

/** Every way to make one Messages call, by name. */
export function callsFor(client: () => AnthropicClient): Array<[string, () => Promise<unknown>]> {
  return [
    ["messages.create", () => client().messages.create(REQUEST)],
    [
      "messages.create with stream: true",
      async () => drain(await client().messages.create({ ...REQUEST, stream: true })),
    ],
    ["messages.stream", () => client().messages.stream(REQUEST).finalMessage()],
    ["beta.messages.create", () => client().beta.messages.create(REQUEST)],
    ["beta.messages.stream", () => client().beta.messages.stream(REQUEST).finalMessage()],
  ];
}

/** Whether a span is one the Anthropic SDK made itself. */
export function isNative(span: ReadableSpan): boolean {
  return span.instrumentationScope.name.startsWith("com.anthropic.sdk.");
}

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

export function backendView(span: ReadableSpan): { badge: string; priced: boolean } {
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

/**
 * The exported spans of one call are one LLM call to the backend: one
 * OpenInference LLM span, badged and priced, and the SDK's own span (where
 * there is one) demoted to a plain CLIENT span that is neither.
 */
export function expectOneLlmCall(spans: ReadableSpan[]): void {
  const llm = spans.filter((s) => s.attributes[OPENINFERENCE_SPAN_KIND] === "LLM");
  expect(llm.map((s) => s.instrumentationScope.name)).toEqual([
    "@arizeai/openinference-instrumentation-anthropic",
  ]);
  // What the backend classes and prices a call by: one model, one usage.
  expect(spans.filter((s) => s.attributes[GEN_AI_REQUEST_MODEL] !== undefined)).toHaveLength(1);
  expect(spans.filter((s) => s.attributes[GEN_AI_USAGE_INPUT_TOKENS] !== undefined)).toHaveLength(
    1,
  );
  expect(llm.map(backendView)).toEqual([{ badge: "llm", priced: true }]);

  const native = spans.filter(isNative);
  expect(native).toHaveLength(TRACES_ITSELF ? 1 : 0);
  for (const span of native) {
    // Demoted, not dropped: still the call's CLIENT span, with its HTTP facts.
    const genAi = Object.keys(span.attributes).filter((k) => k.startsWith("gen_ai."));
    expect(genAi).toEqual(["gen_ai.provider.name"]);
    expect(span.attributes[OPENINFERENCE_SPAN_KIND]).toBeUndefined();
    expect(span.attributes["http.response.status_code"]).toBe(200);
    expect(backendView(span)).toEqual({ badge: "other", priced: false });
  }
}
