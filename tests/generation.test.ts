import { hrTimeToMilliseconds } from "@opentelemetry/core";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { startAsCurrentGeneration, startGeneration } from "../src/generation.js";
import { startAsCurrentSpan } from "../src/spans.js";

let exporter: InMemorySpanExporter;
let client: RiusClient;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  // heartbeat defaults ON; a no-op transport keeps these tests off the network.
  client = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
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
    // Normalised to the GenAI {role, parts} shape, as the Python SDK writes it.
    expect(JSON.parse(span.attributes["gen_ai.input.messages"] as string)).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
    expect(JSON.parse(span.attributes["gen_ai.output.messages"] as string)).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "hello" }] },
    ]);
    expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(42);
    expect(span.attributes["gen_ai.usage.output_tokens"]).toBe(17);
  });

  it("records tool definitions verbatim via the tools option", async () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ];
    const gen = startGeneration("chat", { model: "gpt-4o", tools });
    gen.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(JSON.parse(String(span.attributes["gen_ai.tool.definitions"]))).toEqual(tools);
  });

  it("records tool definitions in any provider shape via setToolDefinitions", async () => {
    // Verbatim on purpose: OpenAI nests under `function`, Anthropic uses
    // top-level name/input_schema; the backend reads names and sizes from either.
    const tools = [
      {
        name: "search_kb",
        description: "Search the knowledge base",
        input_schema: { type: "object", properties: { q: { type: "string" } } },
      },
    ];
    const gen = startGeneration("chat", { model: "claude-sonnet-5", provider: "anthropic" });
    gen.setToolDefinitions(tools);
    gen.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(JSON.parse(String(span.attributes["gen_ai.tool.definitions"]))).toEqual(tools);
  });

  it("leaves gen_ai.tool.definitions absent when no tools are given", async () => {
    const gen = startGeneration("chat", { model: "m" });
    gen.end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["gen_ai.tool.definitions"]).toBeUndefined();
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

  it("recordFirstToken called twice produces exactly one gen_ai.first_token event", async () => {
    const gen = startGeneration("chat", { model: "m" });
    gen.recordFirstToken();
    gen.recordFirstToken();
    gen.end();
    await client.flush();
    const events = exporter
      .getFinishedSpans()[0]
      .events.filter((e) => e.name === "gen_ai.first_token");
    expect(events).toHaveLength(1);
  });

  it("recordFirstToken called ten times in a streaming loop still produces exactly one event", async () => {
    const gen = startGeneration("chat", { model: "m" });
    for (let i = 0; i < 10; i++) {
      gen.recordFirstToken();
    }
    gen.end();
    await client.flush();
    const events = exporter
      .getFinishedSpans()[0]
      .events.filter((e) => e.name === "gen_ai.first_token");
    expect(events).toHaveLength(1);
  });

  it("recordFirstToken records the timestamp of the FIRST call, not the last", async () => {
    // Real, monotonically increasing delays between calls (no clock mocking):
    // the assertion only needs event time to be ordered closer to the first
    // call than the last, which a real delay establishes deterministically
    // as long as the gap comfortably exceeds scheduling jitter (tens of ms
    // here vs. sub-ms overhead per call).
    const gen = startGeneration("chat", { model: "m" });
    gen.recordFirstToken();
    const firstCallTime = Date.now();
    for (let i = 0; i < 9; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      gen.recordFirstToken();
    }
    const lastCallTime = Date.now();
    gen.end();
    await client.flush();
    const events = exporter
      .getFinishedSpans()[0]
      .events.filter((e) => e.name === "gen_ai.first_token");
    expect(events).toHaveLength(1);
    const eventTimeMs = hrTimeToMilliseconds(events[0].time);
    const distanceToFirst = Math.abs(eventTimeMs - firstCallTime);
    const distanceToLast = Math.abs(eventTimeMs - lastCallTime);
    expect(distanceToFirst).toBeLessThan(distanceToLast);
  });

  it("recordFirstToken's guard is per-instance: a second Generation still records its own event", async () => {
    const first = startGeneration("chat", { model: "m" });
    first.recordFirstToken();
    first.recordFirstToken();
    first.end();

    const second = startGeneration("chat2", { model: "m" });
    second.recordFirstToken();
    second.end();

    await client.flush();
    const spans = exporter.getFinishedSpans();
    const firstEvents = spans
      .find((s) => s.name === "chat")
      ?.events.filter((e) => e.name === "gen_ai.first_token");
    const secondEvents = spans
      .find((s) => s.name === "chat2")
      ?.events.filter((e) => e.name === "gen_ai.first_token");
    expect(firstEvents).toHaveLength(1);
    expect(secondEvents).toHaveLength(1);
  });

  it("recordFirstToken sets time_to_first_chunk and request.stream next to the event", async () => {
    const gen = startGeneration("chat", { model: "m" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    gen.recordFirstToken();
    gen.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    const ttfc = span.attributes["gen_ai.response.time_to_first_chunk"];
    expect(typeof ttfc).toBe("number");
    expect(ttfc as number).toBeGreaterThan(0);
    expect(span.attributes["gen_ai.request.stream"]).toBe(true);
    // The event is kept: it is the timestamp the backend keys on.
    expect(span.events.filter((e) => e.name === "gen_ai.first_token")).toHaveLength(1);
  });

  it("time_to_first_chunk agrees with the event timestamp minus span start", async () => {
    const gen = startGeneration("chat", { model: "m" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    gen.recordFirstToken();
    gen.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    const [event] = span.events.filter((e) => e.name === "gen_ai.first_token");
    expect(event).toBeDefined();
    const fromEventSeconds =
      (hrTimeToMilliseconds(event.time) - hrTimeToMilliseconds(span.startTime)) / 1000;
    const ttfc = span.attributes["gen_ai.response.time_to_first_chunk"] as number;
    // Two clocks (performance.now vs the span's hrtime); allow scheduling jitter.
    expect(Math.abs(ttfc - fromEventSeconds)).toBeLessThan(0.01);
  });

  it("a second recordFirstToken does not change time_to_first_chunk", async () => {
    const gen = startGeneration("chat", { model: "m" });
    gen.recordFirstToken();
    const first = (gen.span as unknown as { attributes: Record<string, unknown> }).attributes[
      "gen_ai.response.time_to_first_chunk"
    ];
    await new Promise((resolve) => setTimeout(resolve, 20));
    gen.recordFirstToken();
    gen.end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["gen_ai.response.time_to_first_chunk"]).toBe(
      first,
    );
  });

  it("a generation without recordFirstToken has neither the event nor the stream attributes", async () => {
    const gen = startGeneration("chat", { model: "m" });
    gen.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.events.filter((e) => e.name === "gen_ai.first_token")).toHaveLength(0);
    expect(span.attributes["gen_ai.response.time_to_first_chunk"]).toBeUndefined();
    expect(span.attributes["gen_ai.request.stream"]).toBeUndefined();
  });

  it("scoped form records time_to_first_chunk from span creation", async () => {
    await startAsCurrentGeneration("chat", { model: "m" }, async (gen) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      gen.recordFirstToken();
    });
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.response.time_to_first_chunk"] as number).toBeGreaterThan(0.005);
    expect(span.attributes["gen_ai.request.stream"]).toBe(true);
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

  it("records the requested reasoning level", async () => {
    const gen = startGeneration("chat", { model: "o4-mini", reasoningLevel: "high" });
    gen.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.request.reasoning.level"]).toBe("high");
  });

  it("leaves the reasoning-level attribute absent when not passed", async () => {
    const gen = startGeneration("chat", { model: "o4-mini" });
    gen.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.request.reasoning.level"]).toBeUndefined();
  });

  it("sums Anthropic cache tokens into the emitted input total", async () => {
    const gen = startGeneration("chat", { model: "m", provider: "anthropic" });
    gen.setUsage({
      inputTokens: 10,
      outputTokens: 202,
      cacheReadInputTokens: 11579,
      cacheWriteInputTokens: 12694,
    });
    gen.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(10 + 11579 + 12694);
    // the subset attributes stay as reported
    expect(span.attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(11579);
    expect(span.attributes["gen_ai.usage.cache_write.input_tokens"]).toBe(12694);
  });

  it("sums for Anthropic case-insensitively", async () => {
    const gen = startGeneration("chat", { provider: "Anthropic" });
    gen.setUsage({ inputTokens: 100, cacheReadInputTokens: 50 });
    gen.end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["gen_ai.usage.input_tokens"]).toBe(150);
  });

  it("leaves the Anthropic input total unchanged without cache tokens", async () => {
    const gen = startGeneration("chat", { provider: "anthropic" });
    gen.setUsage({ inputTokens: 100, outputTokens: 5 });
    gen.end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["gen_ai.usage.input_tokens"]).toBe(100);
  });

  it("never sums for other providers or when no provider is set", async () => {
    const withOpenai = startGeneration("chat", { provider: "openai" });
    withOpenai.setUsage({ inputTokens: 1000, cacheReadInputTokens: 400 });
    withOpenai.end();
    const bare = startGeneration("chat");
    bare.setUsage({ inputTokens: 1000, cacheReadInputTokens: 400 });
    bare.end();
    await client.flush();
    for (const span of exporter.getFinishedSpans()) {
      expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(1000);
    }
  });

  it("emits no input total for Anthropic cache tokens without inputTokens", async () => {
    const gen = startGeneration("chat", { provider: "anthropic" });
    gen.setUsage({ cacheReadInputTokens: 400, cacheWriteInputTokens: 100 });
    gen.end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
  });

  it("setUsage records cache read and creation tokens", async () => {
    const gen = startGeneration("chat", { model: "m" });
    gen.setUsage({
      inputTokens: 10,
      outputTokens: 202,
      cacheReadInputTokens: 11579,
      cacheWriteInputTokens: 12694,
    });
    gen.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(11579);
    expect(span.attributes["gen_ai.usage.cache_write.input_tokens"]).toBe(12694);
  });

  it("setUsage leaves cache-token attributes absent when not passed", async () => {
    const gen = startGeneration("chat", { model: "m" });
    gen.setUsage({ inputTokens: 10, outputTokens: 5 });
    gen.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.usage.cache_read.input_tokens"]).toBeUndefined();
    expect(span.attributes["gen_ai.usage.cache_write.input_tokens"]).toBeUndefined();
  });

  it("setUsage writes zero cache tokens as the number 0, not skipped", async () => {
    const gen = startGeneration("chat", { model: "m" });
    gen.setUsage({ cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });
    gen.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(0);
    expect(span.attributes["gen_ai.usage.cache_write.input_tokens"]).toBe(0);
  });

  it("setUsage records reasoning output tokens", async () => {
    const gen = startGeneration("chat", { model: "m" });
    gen.setUsage({ outputTokens: 900, reasoningOutputTokens: 700 });
    gen.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.usage.reasoning.output_tokens"]).toBe(700);
  });

  it("setUsage leaves the reasoning-token attribute absent when not passed", async () => {
    const gen = startGeneration("chat", { model: "m" });
    gen.setUsage({ inputTokens: 10, outputTokens: 5 });
    gen.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.usage.reasoning.output_tokens"]).toBeUndefined();
  });

  it("setUsage writes zero reasoning tokens as the number 0, not skipped", async () => {
    const gen = startGeneration("chat", { model: "m" });
    gen.setUsage({ reasoningOutputTokens: 0 });
    gen.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.usage.reasoning.output_tokens"]).toBe(0);
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

// GenAI semconv: error.type is Conditionally Required on inference spans that
// end in an error; the error's name only (low cardinality), never the message.
describe("generation error.type", () => {
  it("is set when the scoped generation callback throws", async () => {
    await expect(
      startAsCurrentGeneration("chat", { model: "m" }, async () => {
        throw new TypeError("provider exploded");
      }),
    ).rejects.toThrow("provider exploded");
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["error.type"]).toBe("TypeError");
    expect(span.status.code).toBe(2);
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("is set by the manual handle's recordException", async () => {
    const gen = startGeneration("chat", { model: "m" });
    gen.recordException(new Error("nope"));
    gen.end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["error.type"]).toBe("Error");
  });

  it("is absent on success", async () => {
    await startAsCurrentGeneration("chat", { model: "m" }, async () => "ok");
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["error.type"]).toBeUndefined();
  });
});
