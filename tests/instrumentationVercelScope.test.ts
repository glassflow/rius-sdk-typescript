import http from "node:http";
// The vercel-ai processor runs @arizeai/openinference-vercel's attribute
// transform. That transform translates the Vercel AI SDK's ai.* dialect, but it
// also converts ANY gen_ai.* span it is handed, so run on every span it rewrote
// native and third-party spans alike: flattened llm.input_messages.*, llm.system,
// llm.token_count.total, input/output.mime_type, a duplicated input/output.value,
// and a gen_ai.response.model invented from the request model even on errors.
// It must touch only the spans it exists for.
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { type RiusClient, getTracer, init } from "../src/client.js";
import { startGeneration } from "../src/generation.js";
import { REGISTRY, isVercelDialectSpan } from "../src/instrumentation.js";

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

// @arizeai/openinference-vercel, ai v7 and @ai-sdk/otel declare engines node>=22.
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
const describeWithVercelPackage = describe.skipIf(nodeMajor < 22);

/** Everything about a span that reaches the wire, minus ids and clocks. */
function wireShape(span: ReadableSpan): unknown {
  return {
    name: span.name,
    kind: span.kind,
    status: span.status,
    attributes: span.attributes,
    events: span.events.map((e) => ({ name: e.name, attributes: e.attributes })),
    scope: span.instrumentationScope.name,
  };
}

// One error for both runs, so its stack trace is identical and the comparison
// below is of what the pipeline did, not of where the test threw.
const FAILURE = new Error("boom");

/** A successful and a failed native generation, exported through init(). */
async function nativeGenerations(): Promise<unknown[]> {
  const exporter = new InMemorySpanExporter();
  const client = initTracked({ spanExporter: exporter, heartbeatTransport: async () => {} });
  await client.ready;
  const ok = startGeneration("chat gpt-4o", {
    model: "gpt-4o",
    provider: "openai",
    input: [{ role: "user", content: "what is 2+2" }],
    modelParameters: { temperature: 0.2 },
  });
  ok.setOutput({ role: "assistant", content: "4" });
  ok.setUsage({ inputTokens: 5, outputTokens: 1 });
  ok.setFinishReasons("stop");
  ok.end();
  const failed = startGeneration("chat gpt-4o", {
    model: "gpt-4o",
    provider: "openai",
    input: [{ role: "user", content: "hi" }],
  });
  failed.recordException(FAILURE);
  failed.end();
  await client.flush();
  const shapes = exporter.getFinishedSpans().map(wireShape);
  await client.shutdown();
  live = undefined;
  return shapes;
}

describe("isVercelDialectSpan", () => {
  const span = (attributes: Record<string, unknown>) => ({ attributes }) as unknown as ReadableSpan;

  it("accepts every operation id the AI SDK assigns", () => {
    for (const id of ["ai.generateText", "ai.streamText.doStream", "ai.toolCall", "ai.embedMany"]) {
      expect(isVercelDialectSpan(span({ "ai.operationId": id }))).toBe(true);
    }
  });

  it("rejects a span without one, or with an id outside the ai. namespace", () => {
    expect(isVercelDialectSpan(span({}))).toBe(false);
    expect(isVercelDialectSpan(span({ "operation.name": "ai.generateText" }))).toBe(false);
    expect(isVercelDialectSpan(span({ "ai.operationId": "generateText" }))).toBe(false);
    expect(isVercelDialectSpan(span({ "ai.operationId": 1 }))).toBe(false);
  });
});

describeWithVercelPackage("the vercel-ai transform's scope", () => {
  it("leaves a native generation byte-identical to a run without the Vercel package", async () => {
    const withPackage = await nativeGenerations();

    // The same pipeline with the Vercel package absent: the entry's own load
    // resolves nothing, exactly as `optional()` does when it is not installed.
    const index = REGISTRY.findIndex((e) => e.name === "vercel-ai");
    const entry = REGISTRY[index];
    if (entry === undefined) throw new Error("test setup: no vercel-ai entry");
    REGISTRY.splice(index, 1, { ...entry, load: async () => undefined });
    let withoutPackage: unknown[];
    try {
      withoutPackage = await nativeGenerations();
    } finally {
      REGISTRY.splice(index, 1, entry);
    }

    expect(withPackage).toHaveLength(2);
    expect(JSON.stringify(withPackage)).toBe(JSON.stringify(withoutPackage));
    // Spelled out, so a failure names the leak rather than a JSON diff.
    const failed = withPackage[1] as { attributes: Record<string, unknown> };
    expect(failed.attributes["gen_ai.response.model"]).toBeUndefined();
    expect(Object.keys(failed.attributes).some((k) => k.startsWith("llm."))).toBe(false);
  });

  it("leaves a third-party gen_ai span with no ai.operationId untouched", async () => {
    const exporter = new InMemorySpanExporter();
    const client = initTracked({ spanExporter: exporter, heartbeatTransport: async () => {} });
    expect(await client.ready).toContain("vercel-ai");
    // `operation.name` alone is a display label any producer may set; the
    // Vercel AI SDK's own fact is ai.operationId.
    getTracer()
      .startSpan("chat m", {
        attributes: {
          "operation.name": "ai.generateText.doGenerate",
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "m",
          "gen_ai.input.messages": JSON.stringify([
            { role: "user", parts: [{ type: "text", content: "hi" }] },
          ]),
        },
      })
      .end();
    await client.flush();
    const attributes = exporter.getFinishedSpans()[0]?.attributes ?? {};
    expect(Object.keys(attributes).filter((k) => k.startsWith("llm."))).toEqual([]);
    expect(attributes["input.mime_type"]).toBeUndefined();
    expect(attributes["gen_ai.response.model"]).toBeUndefined();
  });
});

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

/** Runs one real generateText with the given telemetry integration registered. */
async function generateWith(
  integration: "legacy" | "genai",
): Promise<Array<Record<string, unknown>>> {
  const { generateText, registerTelemetry } = await import("ai");
  const { createOpenAI } = await import("@ai-sdk/openai");
  const otel = await import("@ai-sdk/otel");
  const exporter = new InMemorySpanExporter();
  const client = initTracked({ spanExporter: exporter, heartbeatTransport: async () => {} });
  expect(await client.ready).toContain("vercel-ai");
  if (integration === "legacy") {
    // The ai.* dialect of AI SDK v5/v6, which @ai-sdk/otel still ships for v7
    // as LegacyOpenTelemetry: the real spans the transform exists for.
    (globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] }).AI_SDK_TELEMETRY_INTEGRATIONS =
      [];
    registerTelemetry(new otel.LegacyOpenTelemetry({ tracer: getTracer() }));
  }
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

describeWithVercelPackage("the vercel-ai transform on real AI SDK spans", () => {
  it("still translates the ai.* dialect", async () => {
    const spans = await generateWith("legacy");
    const llm = spans.find((a) => a["ai.operationId"] === "ai.generateText.doGenerate");
    expect(llm).toBeDefined();
    expect(llm?.["openinference.span.kind"]).toBe("LLM");
    expect(llm?.["llm.model_name"]).toBe("gpt-test");
    expect(llm?.["output.value"]).toBe("4");
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
