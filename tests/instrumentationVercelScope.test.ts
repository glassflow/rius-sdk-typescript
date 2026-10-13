import http from "node:http";
// The Vercel AI SDK's ai.* dialect on real AI SDK spans. The normalizer maps
// it itself, the way the sink maps raw AI SDK traffic, so nothing translates
// these spans beside it: no OpenInference copy of the same facts (flattened
// llm.*, input/output.mime_type, a duplicated input/output.value) rides along.
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { type RiusClient, getTracer, init } from "../src/client.js";

let live: RiusClient | undefined;

function initTracked(options: Parameters<typeof init>[0] = {}): RiusClient {
  live = init(options);
  return live;
}

afterEach(async () => {
  const client = live;
  live = undefined;
  await client?.shutdown().catch(() => {});
  (globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] }).AI_SDK_TELEMETRY_INTEGRATIONS = [];
});

// ai v7 and @ai-sdk/otel declare engines node>=22.
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
const describeV7 = describe.skipIf(nodeMajor < 22);

/** An HTTP server answering every request with an OpenAI chat completion. */
async function stubServer(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 1700000000,
          model: "gpt-test",
          choices: [
            { index: 0, message: { role: "assistant", content: "4" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  return { url: `http://127.0.0.1:${address.port}/v1`, close: () => server.close() };
}

/**
 * Replaces the registered integration with @ai-sdk/otel's LegacyOpenTelemetry:
 * the ai.* dialect of AI SDK v5/v6, which @ai-sdk/otel still ships for v7.
 */
async function useLegacyIntegration(): Promise<void> {
  const { registerTelemetry } = await import("ai");
  const { LegacyOpenTelemetry } = await import("@ai-sdk/otel");
  (globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] }).AI_SDK_TELEMETRY_INTEGRATIONS = [];
  registerTelemetry(new LegacyOpenTelemetry({ tracer: getTracer() }));
}

/** Runs one real generateText with the given telemetry integration registered. */
async function generateWith(
  integration: "legacy" | "genai",
): Promise<Array<Record<string, unknown>>> {
  const { generateText } = await import("ai");
  const { createOpenAI } = await import("@ai-sdk/openai");
  const exporter = new InMemorySpanExporter();
  const client = initTracked({ spanExporter: exporter, heartbeatTransport: async () => {} });
  expect(await client.ready).toContain("vercel-ai");
  if (integration === "legacy") await useLegacyIntegration();
  const stub = await stubServer();
  try {
    const openai = createOpenAI({ apiKey: "not-a-real-key", baseURL: stub.url });
    await generateText({ model: openai.chat("gpt-test"), prompt: "what is 2+2" });
    await client.flush();
  } finally {
    stub.close();
  }
  return exporter.getFinishedSpans().map((s) => s.attributes as Record<string, unknown>);
}

describeV7("the ai.* dialect on real AI SDK spans", () => {
  it("maps a model call natively, with no OpenInference copy beside it", async () => {
    const spans = await generateWith("legacy");
    const llm = spans.find((a) => a["ai.operationId"] === "ai.generateText.doGenerate");
    expect(llm).toBeDefined();
    expect(llm?.["openinference.span.kind"]).toBe("LLM");
    expect(llm?.["gen_ai.provider.name"]).toBe("openai");
    expect(llm?.["gen_ai.response.model"]).toBe("gpt-test");
    expect(JSON.parse(llm?.["gen_ai.output.messages"] as string)).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "4" }], finish_reason: "stop" },
    ]);
    expect(Object.keys(llm ?? {}).filter((k) => k.startsWith("llm."))).toEqual([]);
    expect(llm?.["output.value"]).toBeUndefined();
    expect(llm?.["input.mime_type"]).toBeUndefined();
  });

  it("maps a rerank natively", async () => {
    const { rerank } = await import("ai");
    const { MockRerankingModelV4 } = await import("ai/test");
    const exporter = new InMemorySpanExporter();
    const client = initTracked({ spanExporter: exporter, heartbeatTransport: async () => {} });
    await client.ready;
    await useLegacyIntegration();
    await rerank({
      model: new MockRerankingModelV4({
        provider: "cohere.reranking",
        modelId: "rerank-v3.5",
        doRerank: async () => ({ ranking: [{ index: 1, relevanceScore: 0.9 }] }),
      }),
      query: "capital of France",
      documents: ["Berlin", "Paris"],
    });
    await client.flush();
    const spans = exporter.getFinishedSpans().map((s) => s.attributes);
    const ids = spans.map((a) => a["ai.operationId"]);
    expect(ids).toContain("ai.rerank");
    for (const attributes of spans) {
      expect(attributes["gen_ai.operation.name"]).toBe("rerank");
      expect(attributes["gen_ai.provider.name"]).toBe("cohere");
      expect(attributes["gen_ai.request.model"]).toBe("rerank-v3.5");
      expect(Object.keys(attributes).filter((k) => k.startsWith("llm."))).toEqual([]);
    }
  });

  it("skips the GenAI-native spans of @ai-sdk/otel's OpenTelemetry integration", async () => {
    const spans = await generateWith("genai");
    const llm = spans.find((a) => a["gen_ai.operation.name"] === "chat");
    expect(llm).toBeDefined();
    expect(Object.keys(llm ?? {}).filter((k) => k.startsWith("llm."))).toEqual([]);
    expect(llm?.["input.mime_type"]).toBeUndefined();
    expect(llm?.["output.mime_type"]).toBeUndefined();
    // The taxonomy the contract requires still rides: the normalizer derives
    // it from gen_ai.operation.name.
    expect(llm?.["openinference.span.kind"]).toBe("LLM");
    expect(llm?.["gen_ai.usage.input_tokens"]).toBe(5);
  });
});
