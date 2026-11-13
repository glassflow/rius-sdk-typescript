// TanStack AI's otelMiddleware traces a chat() call as a run span, a span for
// each model call and a span for each tool execution. These tests drive the
// real middleware with the package's scripted fake model, so what they pin is
// what the middleware writes, not a hand-built copy of it.
import {
  type Attributes,
  SpanKind as OtelSpanKind,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { init, type RiusClient } from "../src/client.js";
import { NormalizingSpanProcessor } from "../src/normalize.js";
import {
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OPERATION_NAME,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_TOOL_CALL_ARGUMENTS,
  GEN_AI_TOOL_CALL_RESULT,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_PREFIX,
  OPENINFERENCE_SPAN_KIND,
  RIUS_AGGREGATED_USAGE_PREFIX,
} from "../src/semconv.js";

let live: RiusClient | undefined;

afterEach(async () => {
  const client = live;
  live = undefined;
  await client?.shutdown().catch(() => {});
});

const aggregated = (key: string) =>
  RIUS_AGGREGATED_USAGE_PREFIX + key.slice(GEN_AI_USAGE_PREFIX.length);

function keysUnder(attributes: Attributes, prefix: string): string[] {
  return Object.keys(attributes).filter((key) => key.startsWith(prefix));
}

interface RunOptions {
  captureContent?: boolean;
  /** Make the tool throw. */
  failingTool?: boolean;
  /** Script the model to fail on its second call. */
  failingModel?: boolean;
  /** Extra init() options, such as the privacy controls. */
  init?: Parameters<typeof init>[0];
  attributeEnricher?: (info: { kind: string }) => Record<string, string | undefined>;
  /**
   * A second middleware that stops the run when the tool is about to execute,
   * by cancelling it or by throwing. The tool's span is open at that point.
   */
  guard?: "abort" | "throw";
}

/** One chat() call that asks for a tool, runs it, and answers. */
async function runChat(options: RunOptions = {}): Promise<ReadableSpan[]> {
  const { chat, maxIterations, toolDefinition } = await import("@tanstack/ai");
  const { otelMiddleware } = await import("@tanstack/ai/middlewares/otel");
  const { fakeText } = await import("@tanstack/ai/testing");

  const exporter = new InMemorySpanExporter();
  live = init({
    spanExporter: exporter,
    heartbeatTransport: async () => {},
    ...options.init,
  });
  await live.ready;

  const model = fakeText({ model: "fake-model" });
  model.setResponses([
    { toolCalls: [{ name: "get_weather", input: { city: "Berlin" }, id: "call-1" }] },
    options.failingModel ? { error: "upstream is down" } : { text: "Pack a raincoat." },
  ]);
  const getWeather = toolDefinition({
    name: "get_weather",
    description: "Get the weather for a city",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
  }).server(async () => {
    if (options.failingTool) throw new Error("weather service is down");
    return { conditions: "light rain" };
  });

  const streamed = options.failingModel === true || options.guard !== undefined;
  const run = chat({
    adapter: model,
    systemPrompts: ["You are a travel assistant."],
    messages: [{ role: "user", content: "What should I pack for Berlin?" }],
    tools: [getWeather],
    agentLoopStrategy: maxIterations(4),
    threadId: "thread-1",
    middleware: [
      otelMiddleware({
        tracer: trace.getTracer("my-app"),
        captureContent: options.captureContent ?? true,
        attributeEnricher: options.attributeEnricher as never,
      }),
      ...(options.guard === undefined
        ? []
        : [
            {
              name: "guard",
              onBeforeToolCall: () => {
                if (options.guard === "throw") throw new Error("guard broke");
                return { type: "abort", reason: "policy" };
              },
            },
          ]),
    ],
    // A failed model call reaches a streamed run as a RUN_ERROR chunk, and
    // the middleware ends the run's spans on it.
    stream: streamed,
  } as never) as unknown;
  if (streamed) {
    try {
      for await (const _chunk of run as AsyncIterable<unknown>) {
        // Drain: the spans end with the stream.
      }
    } catch {
      // A run stopped by the guard may reject; its spans have ended.
    }
  } else await run;
  await live.flush();
  return exporter.getFinishedSpans();
}

function byName(spans: ReadableSpan[], name: string): ReadableSpan {
  const found = spans.find((span) => span.name === name);
  if (found === undefined) {
    throw new Error(`no span named ${name} among ${spans.map((s) => s.name).join(", ")}`);
  }
  return found;
}

describe("a TanStack AI chat() run traced by its otelMiddleware", () => {
  it("counts each model call once: the run's total moves to rius.aggregated_usage.*", async () => {
    const spans = await runChat();
    const run = byName(spans, "chat fake-model");
    const calls = [byName(spans, "chat fake-model #0"), byName(spans, "chat fake-model #1")];

    expect(keysUnder(run.attributes, GEN_AI_USAGE_PREFIX)).toEqual([]);
    const total = (key: string) =>
      calls.reduce((sum, call) => sum + Number(call.attributes[key] ?? 0), 0);
    expect(total(GEN_AI_USAGE_INPUT_TOKENS)).toBeGreaterThan(0);
    expect(run.attributes[aggregated(GEN_AI_USAGE_INPUT_TOKENS)]).toBe(
      total(GEN_AI_USAGE_INPUT_TOKENS),
    );
    expect(run.attributes[aggregated(GEN_AI_USAGE_OUTPUT_TOKENS)]).toBe(
      total(GEN_AI_USAGE_OUTPUT_TOKENS),
    );
    // Summed over every span, as a backend does, the usage is the calls' alone.
    const everySpan = spans.reduce(
      (sum, span) => sum + Number(span.attributes[GEN_AI_USAGE_INPUT_TOKENS] ?? 0),
      0,
    );
    expect(everySpan).toBe(total(GEN_AI_USAGE_INPUT_TOKENS));
  });

  it("names the run an agent run, each model call a chat and each tool an execution", async () => {
    const spans = await runChat();
    const run = byName(spans, "chat fake-model");
    expect(run.attributes[OPENINFERENCE_SPAN_KIND]).toBe("AGENT");
    expect(run.attributes[GEN_AI_OPERATION_NAME]).toBe("invoke_agent");
    for (const name of ["chat fake-model #0", "chat fake-model #1"]) {
      const call = byName(spans, name);
      expect(call.attributes[OPENINFERENCE_SPAN_KIND]).toBe("LLM");
      expect(call.attributes[GEN_AI_OPERATION_NAME]).toBe("chat");
    }
    const tool = byName(spans, "execute_tool get_weather");
    expect(tool.attributes[OPENINFERENCE_SPAN_KIND]).toBe("TOOL");
    expect(tool.attributes[GEN_AI_OPERATION_NAME]).toBe("execute_tool");
  });

  it("gives a tool span its arguments and result, not a message list", async () => {
    const spans = await runChat();
    const tool = byName(spans, "execute_tool get_weather");
    expect(tool.attributes[GEN_AI_TOOL_CALL_ARGUMENTS]).toBe('{"city":"Berlin"}');
    expect(tool.attributes[GEN_AI_TOOL_CALL_RESULT]).toBe('{"conditions":"light rain"}');
    expect(tool.attributes[GEN_AI_INPUT_MESSAGES]).toBeUndefined();
    expect(tool.attributes[GEN_AI_OUTPUT_MESSAGES]).toBeUndefined();
  });

  it("writes the messages of the run and of each model call in the GenAI schema", async () => {
    const spans = await runChat();
    const question = {
      role: "user",
      parts: [{ type: "text", content: "What should I pack for Berlin?" }],
    };
    const answer = [{ role: "assistant", parts: [{ type: "text", content: "Pack a raincoat." }] }];

    const run = byName(spans, "chat fake-model");
    expect(JSON.parse(String(run.attributes[GEN_AI_INPUT_MESSAGES]))).toContainEqual(question);
    expect(JSON.parse(String(run.attributes[GEN_AI_OUTPUT_MESSAGES]))).toEqual(answer);

    const last = byName(spans, "chat fake-model #1");
    expect(JSON.parse(String(last.attributes[GEN_AI_INPUT_MESSAGES]))).toContainEqual(question);
    expect(JSON.parse(String(last.attributes[GEN_AI_OUTPUT_MESSAGES]))).toEqual(answer);
  });

  it("drops the Langfuse mirrors of what the span now carries", async () => {
    const spans = await runChat();
    for (const span of spans) {
      expect(keysUnder(span.attributes, "langfuse."), span.name).toEqual([]);
    }
  });

  it("drops the message events, which repeat the messages in a shape masking cannot read", async () => {
    const spans = await runChat();
    for (const span of spans) {
      const names = span.events.map((event) => event.name);
      expect(
        names.filter((name) => name.startsWith("gen_ai.")),
        span.name,
      ).toEqual([]);
    }
  });

  it("carries no content when the middleware captures none, and still counts once", async () => {
    const spans = await runChat({ captureContent: false });
    const run = byName(spans, "chat fake-model");
    expect(run.attributes[GEN_AI_INPUT_MESSAGES]).toBeUndefined();
    expect(run.attributes[OPENINFERENCE_SPAN_KIND]).toBe("AGENT");
    expect(keysUnder(run.attributes, GEN_AI_USAGE_PREFIX)).toEqual([]);
    const tool = byName(spans, "execute_tool get_weather");
    expect(tool.attributes[GEN_AI_TOOL_CALL_ARGUMENTS]).toBeUndefined();
    expect(tool.attributes[OPENINFERENCE_SPAN_KIND]).toBe("TOOL");
  });

  it("keeps a failed tool an error, classified as a tool execution", async () => {
    const spans = await runChat({ failingTool: true });
    const tool = byName(spans, "execute_tool get_weather");
    expect(tool.attributes[OPENINFERENCE_SPAN_KIND]).toBe("TOOL");
    expect(tool.attributes["tanstack.ai.tool.outcome"]).toBe("error");
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
    expect(tool.events.map((event) => event.name)).toContain("exception");
  });

  for (const guard of ["abort", "throw"] as const) {
    it(`keeps a tool span a tool execution when the run stops under it (${guard})`, async () => {
      const spans = await runChat({ guard });
      const tool = byName(spans, "execute_tool get_weather");
      // The middleware closes it without an outcome.
      expect(tool.attributes["tanstack.ai.tool.outcome"]).toBeUndefined();
      expect(tool.attributes[OPENINFERENCE_SPAN_KIND]).toBe("TOOL");
      expect(tool.attributes[GEN_AI_OPERATION_NAME]).toBe("execute_tool");
      expect(tool.attributes[GEN_AI_TOOL_CALL_ARGUMENTS]).toBe('{"city":"Berlin"}');
      expect(tool.attributes[GEN_AI_INPUT_MESSAGES]).toBeUndefined();
      expect(keysUnder(tool.attributes, "langfuse."), tool.name).toEqual([]);

      const run = byName(spans, "chat fake-model");
      expect(run.attributes[OPENINFERENCE_SPAN_KIND]).toBe("AGENT");
      expect(keysUnder(run.attributes, GEN_AI_USAGE_PREFIX)).toEqual([]);
      expect(Number(run.attributes[aggregated(GEN_AI_USAGE_INPUT_TOKENS)])).toBeGreaterThan(0);
    });
  }

  it("moves the usage of a run that failed part way: it never learns its iteration count", async () => {
    const spans = await runChat({ failingModel: true });
    const run = byName(spans, "chat fake-model");
    expect(run.attributes["tanstack.ai.iterations"]).toBeUndefined();
    expect(run.attributes[OPENINFERENCE_SPAN_KIND]).toBe("AGENT");
    expect(keysUnder(run.attributes, GEN_AI_USAGE_PREFIX)).toEqual([]);
    const first = byName(spans, "chat fake-model #0");
    expect(Number(first.attributes[GEN_AI_USAGE_INPUT_TOKENS])).toBeGreaterThan(0);
  });

  it("keeps what the app's attributeEnricher set on the run", async () => {
    const spans = await runChat({
      attributeEnricher: (info) =>
        info.kind === "chat" ? { [OPENINFERENCE_SPAN_KIND]: "CHAIN" } : {},
    });
    const run = byName(spans, "chat fake-model");
    expect(run.attributes[OPENINFERENCE_SPAN_KIND]).toBe("CHAIN");
    // The operation is not filled in beside a kind it does not match.
    expect(run.attributes[GEN_AI_OPERATION_NAME]).toBeUndefined();
    // Whatever the app calls the span, it still repeats its calls' usage.
    expect(keysUnder(run.attributes, GEN_AI_USAGE_PREFIX)).toEqual([]);
    expect(Number(run.attributes[aggregated(GEN_AI_USAGE_INPUT_TOKENS)])).toBeGreaterThan(0);
  });
});

describe("the SDK's privacy controls on what the middleware records", () => {
  const SECRETS = ["What should I pack", "travel assistant", "Berlin", "light rain", "raincoat"];

  function everyString(spans: ReadableSpan[]): string {
    return JSON.stringify(
      spans.map((span) => [span.attributes, span.events.map((event) => event.attributes)]),
    );
  }

  it("captureContent: false strips prompts, answers and tool payloads, events included", async () => {
    const spans = await runChat({ init: { captureContent: false } });
    const exported = everyString(spans);
    for (const secret of SECRETS) expect(exported, secret).not.toContain(secret);
    // What is not content survives.
    const tool = byName(spans, "execute_tool get_weather");
    expect(tool.attributes[OPENINFERENCE_SPAN_KIND]).toBe("TOOL");
  });

  it("a mask sees every string the middleware recorded", async () => {
    const spans = await runChat({ init: { mask: () => "[masked]" } });
    const exported = everyString(spans);
    for (const secret of SECRETS) expect(exported, secret).not.toContain(secret);
    expect(exported).toContain("[masked]");
  });
});

describe("spans the TanStack AI mapping leaves alone", () => {
  function finish(build: (provider: BasicTracerProvider) => void): ReadableSpan[] {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new NormalizingSpanProcessor(), new SimpleSpanProcessor(exporter)],
    });
    build(provider);
    return exporter.getFinishedSpans();
  }

  it("keeps usage on another producer's span that has model calls under it", () => {
    const [child, parent] = finish((provider) => {
      const tracer = provider.getTracer("someone-else");
      const root = tracer.startSpan("run", {
        kind: OtelSpanKind.INTERNAL,
        attributes: { [GEN_AI_USAGE_INPUT_TOKENS]: 10 },
      });
      const call = tracer.startSpan(
        "chat",
        { attributes: { [GEN_AI_OPERATION_NAME]: "chat", [GEN_AI_USAGE_INPUT_TOKENS]: 10 } },
        trace.setSpan(ROOT_CONTEXT, root),
      );
      call.end();
      root.end();
    });
    expect(child?.attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(10);
    expect(parent?.attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(10);
    expect(parent?.attributes[OPENINFERENCE_SPAN_KIND]).toBeUndefined();
  });

  it("does not call a cancelled media generation an agent run", () => {
    const [media] = finish((provider) => {
      // What the middleware writes for an image generation that was cancelled.
      const span = provider.getTracer("my-app").startSpan("image_generation some-model", {
        kind: OtelSpanKind.CLIENT,
        attributes: {
          [GEN_AI_OPERATION_NAME]: "image_generation",
          "tanstack.ai.completion.reason": "cancelled",
          [GEN_AI_USAGE_INPUT_TOKENS]: 5,
        },
      });
      span.end();
    });
    expect(media?.attributes[OPENINFERENCE_SPAN_KIND]).not.toBe("AGENT");
    expect(media?.attributes[GEN_AI_OPERATION_NAME]).toBe("image_generation");
    expect(media?.attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(5);
  });

  it("drops a model call's message event whatever the role in its name", () => {
    const [call] = finish((provider) => {
      const span = provider.getTracer("my-app").startSpan("chat some-model #0", {
        attributes: { "tanstack.ai.iteration": 0 },
      });
      span.addEvent("gen_ai.developer.message", { content: "a prompt" });
      span.addEvent("exception", { "exception.message": "kept" });
      span.end();
    });
    expect(call?.events.map((event) => event.name)).toEqual(["exception"]);
  });

  it("leaves a tool span's message list whole when it is not the middleware's shape", () => {
    const [tool] = finish((provider) => {
      const span = provider.getTracer("my-app").startSpan("execute_tool search", {
        attributes: {
          "tanstack.ai.tool.outcome": "success",
          [GEN_AI_INPUT_MESSAGES]: "not json",
        },
      });
      span.end();
    });
    expect(tool?.attributes[GEN_AI_INPUT_MESSAGES]).toBe("not json");
    expect(tool?.attributes[GEN_AI_TOOL_CALL_ARGUMENTS]).toBeUndefined();
  });
});
