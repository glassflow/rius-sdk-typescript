import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { startAsCurrentGeneration, startGeneration } from "../src/generation.js";
import { startAsCurrentSpan } from "../src/spans.js";

let exporter: InMemorySpanExporter;
let client: RiusClient;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  client = init({ spanExporter: exporter });
});
afterEach(async () => {
  await client.shutdown();
});

describe("generations", () => {
  it("is gen_ai-native: LLM kind, chat operation, model and messages", async () => {
    const gen = startGeneration("chat", {
      model: "gpt-4o",
      input: [{ role: "user", content: "hi" }],
    });
    gen.setOutput([{ role: "assistant", content: "hello" }]);
    gen.setUsage({ inputTokens: 42, outputTokens: 17 });
    gen.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["openinference.span.kind"]).toBe("LLM");
    expect(span.attributes["gen_ai.operation.name"]).toBe("chat");
    expect(span.attributes["gen_ai.request.model"]).toBe("gpt-4o");
    expect(span.attributes["gen_ai.input.messages"]).toBe('[{"role":"user","content":"hi"}]');
    expect(span.attributes["gen_ai.output.messages"]).toBe(
      '[{"role":"assistant","content":"hello"}]',
    );
    expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(42);
    expect(span.attributes["gen_ai.usage.output_tokens"]).toBe(17);
  });

  it("uses gen_ai message keys, not the generic input.value", async () => {
    const gen = startGeneration("chat", { model: "m", input: ["x"] });
    gen.end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["input.value"]).toBeUndefined();
  });

  it("records the first-token event for TTFT", async () => {
    const gen = startGeneration("chat", { model: "m" });
    gen.recordFirstToken();
    gen.end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].events.map((e) => e.name)).toContain(
      "gen_ai.first_token",
    );
  });

  it("scoped form nests, auto-ends and returns the result", async () => {
    const result = await startAsCurrentGeneration("chat", { model: "m" }, async (gen) => {
      gen.setUsage({ inputTokens: 1, outputTokens: 2 });
      return "done";
    });
    expect(result).toBe("done");
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["gen_ai.usage.output_tokens"]).toBe(2);
  });

  it("nests a generation under an enclosing span via context propagation", async () => {
    await startAsCurrentSpan("outer", {}, async (parent) => {
      await startAsCurrentGeneration("chat", { model: "m" }, async () => {
        return undefined;
      });
      return parent;
    });
    await client.flush();
    const spans = exporter.getFinishedSpans();
    const child = spans.find((s) => s.name === "chat");
    const parent = spans.find((s) => s.name === "outer");
    expect(child).toBeDefined();
    expect(parent).toBeDefined();
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
  });

  it("records finish reasons, wrapping a single reason into a list", async () => {
    startGeneration("chat", { model: "m" }).setFinishReasons("stop").end();
    startGeneration("chat2", { model: "m" }).setFinishReasons(["length", "tool_calls"]).end();
    await client.flush();
    const spans = exporter.getFinishedSpans();
    expect(
      spans.find((s) => s.name === "chat")?.attributes["gen_ai.response.finish_reasons"],
    ).toEqual(["stop"]);
    expect(
      spans.find((s) => s.name === "chat2")?.attributes["gen_ai.response.finish_reasons"],
    ).toEqual(["length", "tool_calls"]);
  });

  it("records model parameters under the gen_ai.request prefix", async () => {
    startGeneration("chat", {
      model: "m",
      modelParameters: { temperature: 0.2, max_tokens: 512, stop: "END" },
    }).end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.request.temperature"]).toBe(0.2);
    expect(span.attributes["gen_ai.request.max_tokens"]).toBe(512);
    expect(span.attributes["gen_ai.request.stop"]).toBe("END");
    // The request model keeps its own attribute, not a parameter-derived one.
    expect(span.attributes["gen_ai.request.model"]).toBe("m");
  });

  it("records model parameters in the scoped form too", async () => {
    await startAsCurrentGeneration("chat", { modelParameters: { top_p: 0.9 } }, async () => {});
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["gen_ai.request.top_p"]).toBe(0.9);
  });

  it("accepts the callback directly, with no options argument", async () => {
    expect(await startAsCurrentGeneration("chat", async (gen) => gen.constructor.name)).toBe(
      "Generation",
    );
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["openinference.span.kind"]).toBe("LLM");
  });

  it("setUsage writes zero-token usage as the number 0, not skipped", async () => {
    const gen = startGeneration("chat", { model: "m" });
    gen.setUsage({ inputTokens: 0, outputTokens: 0 });
    gen.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(0);
    expect(span.attributes["gen_ai.usage.output_tokens"]).toBe(0);
  });
});
