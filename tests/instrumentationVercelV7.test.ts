import http from "node:http";
// The Vercel AI SDK v7 removed the per-call `experimental_telemetry.tracer`
// hook: spans exist only if something calls `registerTelemetry()`. The
// vercel-ai entry does that with @ai-sdk/otel's OpenTelemetry integration
// bound to our tracer, so a v7 app is traced with zero telemetry code.
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { type RiusClient, init } from "../src/client.js";

// init() hands back the existing client while one is active, so a client that
// is never shut down silently becomes every later test's client. A test body
// that fails part way through — a timeout in particular, which vitest cannot
// abort — would otherwise leave one behind and take the rest of the file down
// with it, each failure looking like its own bug.
let live: RiusClient | undefined;

/** init(), remembered so the teardown can release it if the test does not. */
function initTracked(options: Parameters<typeof init>[0] = {}): RiusClient {
  live = init(options);
  return live;
}

afterEach(async () => {
  const client = live;
  live = undefined;
  await client?.shutdown().catch(() => {});
});

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
// `ai` v7 and @ai-sdk/otel declare engines node>=22.
const describeV7 = nodeMajor >= 22 ? describe : describe.skip;

/** An HTTP server answering every request with `payload`. */
async function stubServer(payload: unknown): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  return { url: `http://127.0.0.1:${address.port}/v1`, close: () => server.close() };
}

const OPENAI_REPLY = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-test",
  choices: [{ index: 0, message: { role: "assistant", content: "4" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
};

function integrations(): unknown[] {
  return (
    (globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] }).AI_SDK_TELEMETRY_INTEGRATIONS ??
    []
  );
}

describeV7("the vercel-ai entry on ai v7", () => {
  afterEach(() => {
    (globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] }).AI_SDK_TELEMETRY_INTEGRATIONS =
      [];
  });

  it("registers @ai-sdk/otel so a plain generateText call is traced", async () => {
    const { generateText, tool, jsonSchema } = await import("ai");
    const { createOpenAI } = await import("@ai-sdk/openai");

    const inner = new InMemorySpanExporter();
    const client = initTracked({ spanExporter: inner, heartbeatTransport: async () => {} });
    expect(await client.ready).toContain("vercel-ai");
    const stub = await stubServer(OPENAI_REPLY);
    try {
      const openai = createOpenAI({ apiKey: "not-a-real-key", baseURL: stub.url });
      // No telemetry options anywhere: the registration at init() is the point.
      await generateText({
        model: openai.chat("gpt-test"),
        prompt: "what is 2+2",
        tools: {
          get_weather: tool({
            description: "Get weather",
            inputSchema: jsonSchema({
              type: "object",
              properties: { city: { type: "string" } },
            }),
          }),
        },
      });
      await client.flush();
    } finally {
      stub.close();
    }

    // Read before shutdown: InMemorySpanExporter.shutdown() resets its buffer.
    const spans = inner.getFinishedSpans();
    await client.shutdown();
    expect(spans.length).toBeGreaterThan(0);
    const attributesOf = (predicate: (a: Record<string, unknown>) => boolean) =>
      spans.map((s) => s.attributes as Record<string, unknown>).find((a) => predicate(a));

    const llm = attributesOf((a) => a["gen_ai.operation.name"] === "chat");
    expect(llm).toBeDefined();
    // The GenAI-native shape our backend reads directly, tool definitions
    // included — richer than the v5 ai.* path ever was.
    expect(String(llm?.["gen_ai.tool.definitions"])).toContain("get_weather");
    expect(llm?.["gen_ai.usage.input_tokens"]).toBe(5);
    // The OpenInference taxonomy rides along, derived by the normalizer from
    // gen_ai.operation.name: the Vercel transform skips these GenAI-native spans.
    expect(llm?.["openinference.span.kind"]).toBe("LLM");

    const agent = attributesOf((a) => a["gen_ai.operation.name"] === "invoke_agent");
    expect(agent).toBeDefined();
  });

  it("re-init replaces the registration instead of stacking a duplicate", async () => {
    const first = initTracked({
      spanExporter: new InMemorySpanExporter(),
      heartbeatTransport: async () => {},
    });
    await first.ready;
    expect(integrations().length).toBe(1);
    await first.shutdown();

    const second = initTracked({
      spanExporter: new InMemorySpanExporter(),
      heartbeatTransport: async () => {},
    });
    await second.ready;
    // One integration, and it is the fresh one: two would double every span,
    // and keeping the old one would export through a shut-down provider.
    expect(integrations().length).toBe(1);
    await second.shutdown();
  });
});

/**
 * A stub that answers the first request with a tool call and every later one
 * with text, so `generateText` executes the tool: that is the path that emits
 * gen_ai.tool.call.arguments / gen_ai.tool.call.result, the keys the 2026-09-14
 * review found leaking past captureContent: false.
 */
async function toolCallingStub(
  toolArguments: string,
  finalText: string,
): Promise<{ url: string; close: () => void }> {
  let calls = 0;
  const server = http.createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      calls += 1;
      const first = calls === 1;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          ...OPENAI_REPLY,
          choices: [
            first
              ? {
                  index: 0,
                  finish_reason: "tool_calls",
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: { name: "get_weather", arguments: toolArguments },
                      },
                    ],
                  },
                }
              : {
                  index: 0,
                  finish_reason: "stop",
                  message: { role: "assistant", content: finalText },
                },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  return { url: `http://127.0.0.1:${address.port}/v1`, close: () => server.close() };
}

/** Every string an exported span carries: attributes, event attributes, name, status. */
function exportedText(spans: ReturnType<InMemorySpanExporter["getFinishedSpans"]>): string {
  return JSON.stringify(
    spans.map((s) => ({
      name: s.name,
      status: s.status,
      attributes: s.attributes,
      events: s.events.map((e) => ({ name: e.name, attributes: e.attributes })),
    })),
  );
}

describeV7("the privacy boundary on the ai v7 path", () => {
  const SENTINEL = "SENTINEL-7f3a9c";

  afterEach(() => {
    (globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] }).AI_SDK_TELEMETRY_INTEGRATIONS =
      [];
  });

  /** Runs one tool-calling generateText with the sentinel in the system prompt and the tool I/O. */
  async function runWithSentinel(options: Parameters<typeof init>[0]) {
    const { generateText, tool, jsonSchema, stepCountIs } = await import("ai");
    const { createOpenAI } = await import("@ai-sdk/openai");
    const inner = new InMemorySpanExporter();
    const client = initTracked({
      spanExporter: inner,
      heartbeatTransport: async () => {},
      ...options,
    });
    expect(await client.ready).toContain("vercel-ai");
    const stub = await toolCallingStub(
      JSON.stringify({ city: `${SENTINEL} city` }),
      `${SENTINEL} answer`,
    );
    try {
      const openai = createOpenAI({ apiKey: "not-a-real-key", baseURL: stub.url });
      await generateText({
        model: openai.chat("gpt-test"),
        system: `${SENTINEL} system prompt`,
        prompt: `${SENTINEL} user prompt`,
        stopWhen: stepCountIs(2),
        tools: {
          get_weather: tool({
            description: `${SENTINEL} tool description`,
            inputSchema: jsonSchema({ type: "object", properties: { city: { type: "string" } } }),
            execute: async () => ({ temperature: 21, note: `${SENTINEL} tool result` }),
          }),
        },
      });
      await client.flush();
    } finally {
      stub.close();
    }
    const spans = inner.getFinishedSpans();
    await client.shutdown();
    return spans;
  }

  it("the sentinel reaches the exporter with content capture on (the test is live)", async () => {
    const spans = await runWithSentinel({});
    const text = exportedText(spans);
    expect(text).toContain(`${SENTINEL} system prompt`);
    expect(text).toContain(`${SENTINEL} city`);
    expect(text).toContain(`${SENTINEL} tool result`);
  });

  it("never leaves the process with captureContent: false", async () => {
    const spans = await runWithSentinel({ captureContent: false });
    expect(spans.length).toBeGreaterThan(0);
    const text = exportedText(spans);
    expect(text).not.toContain(SENTINEL);
    // Identity still flows: the tool name and taxonomy survive the strip.
    const toolSpan = spans.find((s) => s.attributes["gen_ai.tool.name"] === "get_weather");
    expect(toolSpan).toBeDefined();
  });

  it("is replaced everywhere by a mask", async () => {
    const spans = await runWithSentinel({ mask: () => "[REDACTED]" });
    expect(spans.length).toBeGreaterThan(0);
    expect(exportedText(spans)).not.toContain(SENTINEL);
  });
});
