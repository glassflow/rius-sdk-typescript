import { SpanKind as OtelSpanKind } from "@opentelemetry/api";
import { hrTimeToMilliseconds } from "@opentelemetry/core";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { startAsCurrentGeneration, startGeneration } from "../src/generation.js";
import { isContentKey } from "../src/masking.js";
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

  it("records spec-defined model parameters under their gen_ai.request key", async () => {
    startGeneration("chat", {
      model: "m",
      modelParameters: { temperature: 0.2, max_tokens: 512, stop: "END" },
    }).end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.request.temperature"]).toBe(0.2);
    expect(span.attributes["gen_ai.request.max_tokens"]).toBe(512);
    // OpenAI's `stop` is a recognised spelling of gen_ai.request.stop_sequences,
    // and a lone string is the one-element list the key's type requires.
    expect(span.attributes["gen_ai.request.stop_sequences"]).toEqual(["END"]);
    expect(span.attributes["gen_ai.request.stop"]).toBeUndefined();
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

describe("the OTel SpanKind field", () => {
  it("marks generation spans CLIENT: inference calls a remote model", async () => {
    startGeneration("manual").end();
    await startAsCurrentGeneration("scoped", () => {});
    await client.flush();
    const kinds = Object.fromEntries(exporter.getFinishedSpans().map((s) => [s.name, s.kind]));
    expect(kinds).toEqual({ manual: OtelSpanKind.CLIENT, scoped: OtelSpanKind.CLIENT });
  });
});

// `{gen_ai.operation.name} {gen_ai.request.model}`, per the conventions.
describe("spec-form generation names", () => {
  it("composes from the request model on both surfaces", async () => {
    startGeneration({ model: "gpt-4o" }).end();
    await startAsCurrentGeneration({ model: "gpt-4o" }, () => {});
    await client.flush();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["chat gpt-4o", "chat gpt-4o"]);
  });

  it("composes from the resolved operation, which callers may override", async () => {
    startGeneration({ model: "text-embedding-3-small", operation: "embeddings" }).end();
    await startAsCurrentGeneration(
      { model: "claude-haiku", operation: "text_completion" },
      () => {},
    );
    await client.flush();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual([
      "embeddings text-embedding-3-small",
      "text_completion claude-haiku",
    ]);
  });

  it("falls back to the bare operation without a model", async () => {
    startGeneration().end();
    await startAsCurrentGeneration({ operation: "embeddings" }, () => {});
    await startAsCurrentGeneration(() => {});
    await client.flush();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["chat", "embeddings", "chat"]);
  });

  it("never names the span after the response model, which arrives too late", async () => {
    const gen = startGeneration({ model: "gpt-4o" });
    gen.setModel("gpt-4o-2024-11-20");
    gen.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.name).toBe("chat gpt-4o");
    expect(span.attributes["gen_ai.response.model"]).toBe("gpt-4o-2024-11-20");
  });

  it("lets an explicit name win", async () => {
    startGeneration("summarise", { model: "gpt-4o" }).end();
    await startAsCurrentGeneration("summarise-scoped", { model: "gpt-4o" }, () => {});
    await client.flush();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual([
      "summarise",
      "summarise-scoped",
    ]);
  });

  it("gives a pending snapshot the same name as the final span", async () => {
    await client.shutdown();
    const pendingExporter = new InMemorySpanExporter();
    client = init({
      spanExporter: pendingExporter,
      partialSpans: true,
      heartbeatTransport: async () => {},
    });
    const gen = startGeneration({ model: "gpt-4o" });
    await client.flush();
    const pending = pendingExporter
      .getFinishedSpans()
      .filter((s) => s.attributes["rius.span.pending"] === true);
    // The response model lands after the snapshot; the name must not move.
    gen.setModel("gpt-4o-2024-11-20");
    gen.end();
    await client.flush();
    const final = pendingExporter
      .getFinishedSpans()
      .filter((s) => s.attributes["rius.span.pending"] === undefined);
    expect(pending).toHaveLength(1);
    expect(final).toHaveLength(1);
    expect(pending[0].name).toBe("chat gpt-4o");
    expect(final[0].name).toBe(pending[0].name);
  });
});

// Verified against semantic-conventions-genai @ 8ffdf568e1b4391a99adb081db16e8102e36918e:
// gen_ai.response.id is Recommended on an inference span, gen_ai.output.type
// Conditionally Required "when applicable and if the request includes an
// output format", with the members text / json / image / speech.
describe("the completion id and the requested output type", () => {
  it("sets the output type at creation, where the rest of the request lives", async () => {
    const gen = startGeneration({ model: "gpt-4o", outputType: "json" });
    gen.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.output.type"]).toBe("json");
  });

  it("records the completion id afterwards, since it arrives with the response", async () => {
    const gen = startGeneration({ model: "gpt-4o" });
    gen.setResponseId("chatcmpl-123").setModel("gpt-4o-2024-08-06");
    gen.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.response.id"]).toBe("chatcmpl-123");
    expect(span.attributes["gen_ai.response.model"]).toBe("gpt-4o-2024-08-06");
  });

  it("takes an unrecognised output type at its word rather than validating it", async () => {
    // The registry's member list is open, and a provider's own spelling is
    // still what the caller requested. Silently dropping it would lose the
    // only record of what was asked for.
    const gen = startGeneration({ model: "some-model", outputType: "video" });
    gen.end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["gen_ai.output.type"]).toBe("video");
  });

  it("omits both when the caller supplies neither: nothing is invented", async () => {
    startGeneration({ model: "gpt-4o" }).end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.output.type"]).toBeUndefined();
    expect(span.attributes["gen_ai.response.id"]).toBeUndefined();
  });

  it("carries the output type on the scoped helper too", async () => {
    await startAsCurrentGeneration({ model: "gpt-4o", outputType: "speech" }, (gen) => {
      gen.setResponseId("msg_01abc");
    });
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.output.type"]).toBe("speech");
    expect(span.attributes["gen_ai.response.id"]).toBe("msg_01abc");
  });

  it("does not let the output type into the span name", async () => {
    startGeneration({ model: "gpt-4o", outputType: "image" }).end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].name).toBe("chat gpt-4o");
  });
});

describe("model parameter normalization", () => {
  async function params(parameters: Record<string, unknown>) {
    startGeneration("chat", { modelParameters: parameters }).end();
    await client.flush();
    return exporter.getFinishedSpans()[0].attributes;
  }

  it("puts a spec parameter under gen_ai.request", async () => {
    expect((await params({ temperature: 0.7 }))["gen_ai.request.temperature"]).toBe(0.7);
  });

  it("puts an unrecognised parameter under rius.request, never gen_ai.request", async () => {
    // Our own namespace: OTel's naming guidance forbids extending a
    // semantic-convention namespace with application keys, because the
    // convention is free to define that exact key later.
    const attributes = await params({ myCustomKnob: 3 });
    expect(attributes["rius.request.myCustomKnob"]).toBe(3);
    expect(attributes["gen_ai.request.myCustomKnob"]).toBeUndefined();
  });

  it("records a provider spelling under the canonical name only", async () => {
    // One key per parameter: emitting both would make every consumer
    // de-duplicate, and a convention exists so there is one place to look.
    const attributes = await params({ max_completion_tokens: 256 });
    expect(attributes["gen_ai.request.max_tokens"]).toBe(256);
    expect(attributes["gen_ai.request.max_completion_tokens"]).toBeUndefined();
    expect(attributes["rius.request.max_completion_tokens"]).toBeUndefined();
  });

  it("maps the camelCase spellings a TypeScript caller writes", async () => {
    const attributes = await params({ maxTokens: 64, topP: 0.5, stopSequences: ["x"] });
    expect(attributes["gen_ai.request.max_tokens"]).toBe(64);
    expect(attributes["gen_ai.request.top_p"]).toBe(0.5);
    expect(attributes["gen_ai.request.stop_sequences"]).toEqual(["x"]);
    expect(attributes["gen_ai.request.maxTokens"]).toBeUndefined();
  });

  it("does not treat top_logprobs as top_k", async () => {
    // The registry's note on gen_ai.request.top_k says OpenAI's top_logprobs
    // MUST NOT be reported there: it shapes the response, not the sampling.
    const attributes = await params({ top_logprobs: 5 });
    expect(attributes["rius.request.top_logprobs"]).toBe(5);
    expect(attributes["gen_ai.request.top_k"]).toBeUndefined();
  });

  it("JSON-encodes values OTel cannot store rather than dropping them", async () => {
    // A response_format the model was actually sent is worth keeping, even
    // as a string; unencoded, OTel would discard the attribute outright.
    const attributes = await params({
      response_format: { type: "json_object" },
      mixed: [1, "a"],
      // Booleans are not numbers: [true, 1] is not a homogeneous array.
      flagAndCount: [true, 1],
    });
    expect(attributes["rius.request.response_format"]).toBe('{"type":"json_object"}');
    expect(attributes["rius.request.mixed"]).toBe('[1,"a"]');
    expect(attributes["rius.request.flagAndCount"]).toBe("[true,1]");
  });

  it("skips null and undefined, which mean not set", async () => {
    const attributes = await params({ temperature: null, seed: undefined });
    expect(attributes["gen_ai.request.temperature"]).toBeUndefined();
    expect(attributes["gen_ai.request.seed"]).toBeUndefined();
  });

  it("leaves an unrecognised key untouched apart from the prefix", async () => {
    expect((await params({ "Weird.Key-1": "x" }))["rius.request.Weird.Key-1"]).toBe("x");
  });

  it("resolves nothing through the prototype chain", async () => {
    // A plain-object lookup would find Object.prototype.constructor and
    // treat the caller's key as recognised.
    const attributes = await params({ constructor: 1, toString: 2 });
    expect(attributes["rius.request.constructor"]).toBe(1);
    expect(attributes["rius.request.toString"]).toBe(2);
  });

  it("lets the explicit model option beat a model parameter", async () => {
    // The caller who passed both meant the explicit one, and the span name
    // is composed from it.
    startGeneration({ model: "gpt-4o", modelParameters: { model: "other" } }).end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.request.model"]).toBe("gpt-4o");
    expect(span.name).toBe("chat gpt-4o");
  });

  it("lets the explicit reasoningLevel option beat a reasoning_effort parameter", async () => {
    startGeneration("chat", {
      reasoningLevel: "high",
      modelParameters: { reasoning_effort: "low" },
    }).end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["gen_ai.request.reasoning.level"]).toBe(
      "high",
    );
  });

  it("names a generation from a model passed only as a parameter", async () => {
    // It is gen_ai.request.model by then, which is what the name reads.
    startGeneration({ modelParameters: { model: "gpt-4o" } }).end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].name).toBe("chat gpt-4o");
  });

  it("puts a tools parameter on a key masking recognises as content", async () => {
    const attributes = await params({ tools: [{ name: "get_weather" }] });
    expect(attributes["rius.request.tools"]).toBeDefined();
    expect(isContentKey("rius.request.tools")).toBe(true);
  });

  it("applies the same mapping in the scoped form", async () => {
    await startAsCurrentGeneration("chat", { modelParameters: { topK: 3, knob: 1 } }, () => {});
    await client.flush();
    const attributes = exporter.getFinishedSpans()[0].attributes;
    expect(attributes["gen_ai.request.top_k"]).toBe(3);
    expect(attributes["rius.request.knob"]).toBe(1);
  });
});
