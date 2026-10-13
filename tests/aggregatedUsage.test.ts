import http from "node:http";
import {
  type Attributes,
  SpanKind as OtelSpanKind,
  ROOT_CONTEXT,
  type Span,
  trace,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { aggregatingTracer } from "../src/aggregatedUsage.js";
import { type RiusClient, init } from "../src/client.js";
import { NormalizingSpanProcessor } from "../src/normalize.js";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_PREFIX,
  RIUS_AGGREGATED_USAGE_PREFIX,
} from "../src/semconv.js";

/**
 * A producer that reports a whole agent run's usage on its invoke_agent span,
 * AND each model call's usage on that call's own chat span, has the same tokens
 * twice under gen_ai.usage.*. Any sum over gen_ai.usage.* then counts them
 * twice. For the producers known to do that, the aggregate moves to
 * rius.aggregated_usage.* and the per-call spans keep the canonical keys.
 */

const aggregated = (suffix: string) => `${RIUS_AGGREGATED_USAGE_PREFIX}${suffix}`;

function usageKeys(attributes: Attributes): string[] {
  return Object.keys(attributes).filter((key) => key.startsWith(GEN_AI_USAGE_PREFIX));
}

/** A bare provider carrying only the normalizer, so the rule is all that runs. */
function harness() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new NormalizingSpanProcessor(), new SimpleSpanProcessor(exporter)],
  });
  const plain = provider.getTracer("test");
  return { exporter, plain, wrapped: aggregatingTracer(plain) };
}

function only(exporter: InMemorySpanExporter): ReadableSpan {
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(1);
  return spans[0] as ReadableSpan;
}

const RUN_USAGE: Attributes = {
  [GEN_AI_USAGE_INPUT_TOKENS]: 115,
  [GEN_AI_USAGE_OUTPUT_TOKENS]: 66,
  [GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: 40,
};

describe("aggregate usage on an aggregating producer's invoke_agent span", () => {
  it("moves every gen_ai.usage.* key to rius.aggregated_usage.*", () => {
    const { exporter, wrapped } = harness();
    wrapped
      .startSpan("invoke_agent gpt-4o", {
        kind: OtelSpanKind.INTERNAL,
        attributes: { [GEN_AI_OPERATION_NAME]: "invoke_agent", ...RUN_USAGE },
      })
      .end();

    const { attributes } = only(exporter);
    expect(usageKeys(attributes)).toEqual([]);
    expect(attributes[aggregated("input_tokens")]).toBe(115);
    expect(attributes[aggregated("output_tokens")]).toBe(66);
    expect(attributes[aggregated("cache_read.input_tokens")]).toBe(40);
  });

  it("moves usage written after start too, which is when a run knows its total", () => {
    const { exporter, wrapped } = harness();
    const span = wrapped.startSpan("invoke_agent gpt-4o", {
      kind: OtelSpanKind.INTERNAL,
      attributes: { [GEN_AI_OPERATION_NAME]: "invoke_agent" },
    });
    span.setAttributes(RUN_USAGE);
    span.end();

    const { attributes } = only(exporter);
    expect(usageKeys(attributes)).toEqual([]);
    expect(attributes[aggregated("input_tokens")]).toBe(115);
  });

  it("moves the cache-write count under its current name, after normalization renamed it", () => {
    // @ai-sdk/otel still writes the pre-rename gen_ai.usage.cache_creation.*.
    const { exporter, wrapped } = harness();
    wrapped
      .startSpan("invoke_agent claude", {
        kind: OtelSpanKind.INTERNAL,
        attributes: {
          [GEN_AI_OPERATION_NAME]: "invoke_agent",
          "gen_ai.usage.cache_creation.input_tokens": 12,
        },
      })
      .end();

    const { attributes } = only(exporter);
    expect(usageKeys(attributes)).toEqual([]);
    expect(
      attributes[
        aggregated(GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS.slice(GEN_AI_USAGE_PREFIX.length))
      ],
    ).toBe(12);
    expect(attributes[aggregated("cache_creation.input_tokens")]).toBeUndefined();
  });
});

describe("spans the move leaves alone", () => {
  it("keeps per-call usage on the same producer's chat span", () => {
    const { exporter, wrapped } = harness();
    wrapped
      .startSpan("chat gpt-4o", {
        kind: OtelSpanKind.CLIENT,
        attributes: { [GEN_AI_OPERATION_NAME]: "chat", ...RUN_USAGE },
      })
      .end();

    const { attributes } = only(exporter);
    expect(attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(115);
    expect(Object.keys(attributes).some((k) => k.startsWith(RIUS_AGGREGATED_USAGE_PREFIX))).toBe(
      false,
    );
  });

  it("keeps usage on a CLIENT invoke_agent span: a remote agent's usage is the only record", () => {
    const { exporter, wrapped } = harness();
    wrapped
      .startSpan("invoke_agent remote", {
        kind: OtelSpanKind.CLIENT,
        attributes: { [GEN_AI_OPERATION_NAME]: "invoke_agent", ...RUN_USAGE },
      })
      .end();

    expect(only(exporter).attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(115);
  });

  it("keeps usage on an invoke_agent span from any other producer", () => {
    // Not known to repeat the usage on per-call spans, so it may be the only
    // record of those tokens.
    const { exporter, plain } = harness();
    plain
      .startSpan("invoke_agent other", {
        kind: OtelSpanKind.INTERNAL,
        attributes: { [GEN_AI_OPERATION_NAME]: "invoke_agent", ...RUN_USAGE },
      })
      .end();

    expect(only(exporter).attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(115);
  });

  it("marks spans started through startActiveSpan as well", () => {
    const { exporter, wrapped } = harness();
    wrapped.startActiveSpan(
      "invoke_agent gpt-4o",
      {
        kind: OtelSpanKind.INTERNAL,
        attributes: { [GEN_AI_OPERATION_NAME]: "invoke_agent", ...RUN_USAGE },
      },
      (span) => span.end(),
    );

    expect(usageKeys(only(exporter).attributes)).toEqual([]);
  });
});

// The end-to-end shape that double counted: the AI SDK v7 through @ai-sdk/otel.
// `ai` v7 and @ai-sdk/otel declare engines node>=22.
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
const describeV7 = nodeMajor >= 22 ? describe : describe.skip;

let live: RiusClient | undefined;

afterEach(async () => {
  const client = live;
  live = undefined;
  await client?.shutdown().catch(() => {});
  (globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] }).AI_SDK_TELEMETRY_INTEGRATIONS = [];
});

/** An HTTP server answering request n with replies[n], repeating the last. */
async function stubServer(replies: unknown[]): Promise<{ url: string; close: () => void }> {
  let served = 0;
  const server = http.createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      const reply = replies[Math.min(served, replies.length - 1)];
      served += 1;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  return { url: `http://127.0.0.1:${address.port}/v1`, close: () => server.close() };
}

const completion = (message: unknown, finish: string, input: number, output: number) => ({
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-test",
  choices: [{ index: 0, message, finish_reason: finish }],
  usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
});

describeV7("a two-step generateText on ai v7", () => {
  it("counts each model call once under gen_ai.usage.*", async () => {
    const { generateText, tool, jsonSchema, stepCountIs } = await import("ai");
    const { createOpenAI } = await import("@ai-sdk/openai");

    const exporter = new InMemorySpanExporter();
    live = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
    expect(await live.ready).toContain("vercel-ai");
    // Step 1 asks for a tool, step 2 answers: two model calls in one run.
    const stub = await stubServer([
      completion(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
          ],
        },
        "tool_calls",
        24,
        51,
      ),
      completion({ role: "assistant", content: "Sunny" }, "stop", 91, 15),
    ]);
    try {
      const openai = createOpenAI({ apiKey: "not-a-real-key", baseURL: stub.url });
      await generateText({
        model: openai.chat("gpt-test"),
        prompt: "weather in Paris?",
        stopWhen: stepCountIs(2),
        tools: {
          get_weather: tool({
            inputSchema: jsonSchema({
              type: "object",
              properties: { city: { type: "string" } },
            }),
            execute: async () => "sunny",
          }),
        },
      });
      await live.flush();
    } finally {
      stub.close();
    }

    const spans = exporter.getFinishedSpans();
    const sum = (key: string) =>
      spans.reduce((total, span) => total + Number(span.attributes[key] ?? 0), 0);
    // The real usage: 24 + 91 in, 51 + 15 out. Summed over every span, as the
    // backend does, it was twice that before the move.
    expect(sum(GEN_AI_USAGE_INPUT_TOKENS)).toBe(115);
    expect(sum(GEN_AI_USAGE_OUTPUT_TOKENS)).toBe(66);

    const agent = spans.find((s) => s.attributes[GEN_AI_OPERATION_NAME] === "invoke_agent");
    expect(agent?.attributes[aggregated("input_tokens")]).toBe(115);
    expect(agent?.attributes[aggregated("output_tokens")]).toBe(66);
    expect(spans.filter((s) => s.attributes[GEN_AI_OPERATION_NAME] === "chat")).toHaveLength(2);
  });
});

describe("usage a wrapper span repeats from the provider call under it", () => {
  // LangChain's ChatOpenAI span and the openai span under it carry the same
  // call's usage. The provider span keeps it; the wrapper's copy moves aside.
  const USAGE: Attributes = { [GEN_AI_USAGE_INPUT_TOKENS]: 42, [GEN_AI_USAGE_OUTPUT_TOKENS]: 9 };

  function tracers() {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new NormalizingSpanProcessor(), new SimpleSpanProcessor(exporter)],
    });
    return {
      exporter,
      langchain: provider.getTracer("@arizeai/openinference-instrumentation-langchain"),
      openai: provider.getTracer("@arizeai/openinference-instrumentation-openai"),
    };
  }

  function under(span: Span) {
    return trace.setSpan(ROOT_CONTEXT, span);
  }

  function named(exporter: InMemorySpanExporter, name: string): ReadableSpan {
    const span = exporter.getFinishedSpans().find((s) => s.name === name);
    expect(span).toBeDefined();
    return span as ReadableSpan;
  }

  it("moves the wrapper's usage when a child with usage ended under it", () => {
    const { exporter, langchain, openai } = tracers();
    const outer = langchain.startSpan("ChatOpenAI");
    openai.startSpan("OpenAI Chat Completions", { attributes: USAGE }, under(outer)).end();
    outer.setAttributes(USAGE);
    outer.end();
    expect(named(exporter, "OpenAI Chat Completions").attributes).toMatchObject(USAGE);
    const moved = named(exporter, "ChatOpenAI").attributes;
    expect(usageKeys(moved)).toEqual([]);
    expect(moved[aggregated("input_tokens")]).toBe(42);
    expect(moved[aggregated("output_tokens")]).toBe(9);
  });

  it("keeps the wrapper's usage when no child recorded the call", () => {
    const { exporter, langchain, openai } = tracers();
    const outer = langchain.startSpan("ChatOpenAI");
    openai.startSpan("OpenAI Chat Completions", {}, under(outer)).end();
    outer.setAttributes(USAGE);
    outer.end();
    expect(named(exporter, "ChatOpenAI").attributes).toMatchObject(USAGE);
  });

  it("leaves a parent from any other instrumentation alone", () => {
    const { exporter, openai } = tracers();
    const outer = openai.startSpan("outer");
    openai.startSpan("inner", { attributes: USAGE }, under(outer)).end();
    outer.setAttributes(USAGE);
    outer.end();
    expect(named(exporter, "outer").attributes).toMatchObject(USAGE);
  });

  it("does not match a wrapper with a child in another trace", () => {
    const { exporter, langchain, openai } = tracers();
    const outer = langchain.startSpan("ChatOpenAI");
    openai.startSpan("OpenAI Chat Completions", { attributes: USAGE }).end();
    outer.setAttributes(USAGE);
    outer.end();
    expect(named(exporter, "ChatOpenAI").attributes).toMatchObject(USAGE);
  });
});
