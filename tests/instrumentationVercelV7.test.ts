import http from "node:http";
// The Vercel AI SDK v7 removed the per-call `experimental_telemetry.tracer`
// hook: spans exist only if something calls `registerTelemetry()`. The
// vercel-ai entry does that with @ai-sdk/otel's OpenTelemetry integration
// bound to our tracer, so a v7 app is traced with zero telemetry code.
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { init } from "../src/client.js";

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
    const client = init({ spanExporter: inner, heartbeatTransport: async () => {} });
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
    // The transform processor still runs, so OpenInference taxonomy rides along.
    expect(llm?.["openinference.span.kind"]).toBe("LLM");

    const agent = attributesOf((a) => a["gen_ai.operation.name"] === "invoke_agent");
    expect(agent).toBeDefined();
  });

  it("re-init replaces the registration instead of stacking a duplicate", async () => {
    const first = init({
      spanExporter: new InMemorySpanExporter(),
      heartbeatTransport: async () => {},
    });
    await first.ready;
    expect(integrations().length).toBe(1);
    await first.shutdown();

    const second = init({
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
