import http from "node:http";
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { installLangchainSpanContext } from "../src/langchainSpanContext.js";

// A LangChain chat model call, end to end: a real ChatOpenAI against a local
// server, with the LangChain and openai OpenInference instrumentations init()
// enables. The LangChain instrumentation never makes its spans current, so on
// its own the openai span lands in a trace of its own and the call's usage is
// counted twice. With langchainSpanContext it nests under the LangChain span,
// and the LangChain span's usage moves to rius.aggregated_usage.*.
//
// A file of its own: the OpenInference packages keep module-level patch state,
// and vitest's per-file module isolation keeps that state to this file.

const { ChatOpenAI } = await import("@langchain/openai");
const { HumanMessage } = await import("@langchain/core/messages");
const { BaseCallbackHandler } = await import("@langchain/core/callbacks/base");
const { ChatPromptTemplate } = await import("@langchain/core/prompts");
// The ESM namespace @langchain/openai imports, handed to init() so the openai
// instrumentation patches the same module the model calls through.
const openaiSdk = await import("openai");
const openaiInstrumentation = await import("@arizeai/openinference-instrumentation-openai");

const USAGE = { prompt_tokens: 42, completion_tokens: 9, total_tokens: 51 };

function completion(): unknown {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o-mini-2024-07-18",
    choices: [
      { index: 0, message: { role: "assistant", content: "Paris." }, finish_reason: "stop" },
    ],
    usage: USAGE,
  };
}

function sse(): string {
  const chunk = (delta: unknown, finish: string | null = null, usage: unknown = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "gpt-4o-mini-2024-07-18",
      choices: usage ? [] : [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    })}\n\n`;
  return [
    chunk({ role: "assistant", content: "" }),
    chunk({ content: "Par" }),
    chunk({ content: "is." }),
    chunk({}, "stop"),
    chunk({}, null, USAGE),
    "data: [DONE]\n\n",
  ].join("");
}

async function server(): Promise<{ url: string; close: () => void }> {
  const srv = http.createServer((request, response) => {
    let body = "";
    request.on("data", (part) => {
      body += part;
    });
    request.on("end", () => {
      const request_ = JSON.parse(body) as { stream?: boolean; model?: string };
      if (request_.model === "no-such-model") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "no such model", type: "invalid" } }));
        return;
      }
      if (request_.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sse());
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(completion()));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const address = srv.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  return { url: `http://127.0.0.1:${address.port}`, close: () => srv.close() };
}

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
// @langchain/core 1.x needs Node 20 (it reads the global crypto Node 18 lacks).
const describeLangChain = nodeMajor >= 20 ? describe : describe.skip;

describeLangChain("LangChain with the openai instrumentation", () => {
  let mock: { url: string; close: () => void };
  let exporter: InMemorySpanExporter;
  let client: RiusClient;

  beforeAll(async () => {
    mock = await server();
    exporter = new InMemorySpanExporter();
    client = init({
      spanExporter: exporter,
      heartbeatTransport: async () => {},
      instrumentModules: { openai: { instrumentation: openaiInstrumentation, sdk: openaiSdk } },
    });
    const ready = await client.ready;
    expect(ready).toContain("langchain");
    expect(ready).toContain("openai");
  });

  afterAll(async () => {
    await client.shutdown();
    mock.close();
  });

  function model(fields: Record<string, unknown> = {}) {
    return new ChatOpenAI({
      model: "gpt-4o-mini",
      apiKey: "not-a-real-key",
      maxRetries: 0,
      configuration: { baseURL: mock.url },
      ...fields,
    });
  }

  async function finished(): Promise<ReadableSpan[]> {
    await client.flush();
    const spans = exporter.getFinishedSpans();
    exporter.reset();
    return spans;
  }

  const LANGCHAIN = "@arizeai/openinference-instrumentation-langchain";
  const OPENAI = "@arizeai/openinference-instrumentation-openai";

  /** Each LangChain LLM span with the openai span it is the parent of. */
  function pairs(spans: ReadableSpan[]): Array<[ReadableSpan, ReadableSpan]> {
    const byId = new Map(spans.map((span) => [span.spanContext().spanId, span]));
    return spans
      .filter((span) => span.instrumentationScope.name === OPENAI)
      .map((inner) => {
        const parent = inner.parentSpanContext;
        expect(parent, "the provider span has no parent").toBeDefined();
        const outer = byId.get(parent?.spanId ?? "");
        expect(outer?.instrumentationScope.name).toBe(LANGCHAIN);
        expect(outer?.spanContext().traceId).toBe(inner.spanContext().traceId);
        return [outer as ReadableSpan, inner];
      });
  }

  function expectCountedOnce([outer, inner]: [ReadableSpan, ReadableSpan]): void {
    // The provider span is the call, so it keeps the usage; LangChain's copy moves aside.
    expect(inner.attributes["gen_ai.usage.input_tokens"]).toBe(42);
    expect(inner.attributes["gen_ai.usage.output_tokens"]).toBe(9);
    expect(Object.keys(outer.attributes).filter((key) => key.startsWith("gen_ai.usage."))).toEqual(
      [],
    );
    expect(outer.attributes["rius.aggregated_usage.input_tokens"]).toBe(42);
    expect(outer.attributes["rius.aggregated_usage.output_tokens"]).toBe(9);
  }

  describe("LangChain chat model calls nest their provider span", () => {
    it("invoke: nested, usage counted once", async () => {
      await model().invoke([new HumanMessage("Capital of France?")]);
      const found = pairs(await finished());
      expect(found).toHaveLength(1);
      expectCountedOnce(found[0] as [ReadableSpan, ReadableSpan]);
    });

    it("stream: nested, usage counted once", async () => {
      let text = "";
      for await (const chunk of await model({ streamUsage: true }).stream([
        new HumanMessage("Capital of France?"),
      ])) {
        text += String(chunk.content);
      }
      expect(text).toBe("Paris.");
      const found = pairs(await finished());
      expect(found).toHaveLength(1);
      expectCountedOnce(found[0] as [ReadableSpan, ReadableSpan]);
    });

    it("two calls in one chain: each matches its own", async () => {
      const prompt = ChatPromptTemplate.fromMessages([["human", "Capital of {country}?"]]);
      const chat = model();
      await prompt
        .pipe(chat)
        .pipe(() => ({ country: "Germany" }))
        .pipe(prompt)
        .pipe(chat)
        .invoke({ country: "France" });
      const found = pairs(await finished());
      expect(found).toHaveLength(2);
      expect(found[0]?.[0].spanContext().spanId).not.toBe(found[1]?.[0].spanContext().spanId);
      for (const pair of found) expectCountedOnce(pair);
    });

    it("parallel identical calls: each matches its own", async () => {
      const chat = model();
      await Promise.all(
        Array.from({ length: 4 }, () => chat.invoke([new HumanMessage("Capital of France?")])),
      );
      const found = pairs(await finished());
      expect(found).toHaveLength(4);
      expect(new Set(found.map(([outer]) => outer.spanContext().spanId)).size).toBe(4);
      for (const pair of found) expectCountedOnce(pair);
    });

    it("a failed call still nests, and its error reaches the caller unchanged", async () => {
      await expect(
        model({ model: "no-such-model" }).invoke([new HumanMessage("Capital of France?")]),
      ).rejects.toThrow(/no such model/);
      expect(pairs(await finished())).toHaveLength(1);
    });

    it("a lookup that throws never reaches the caller", async () => {
      const hostile = BaseCallbackHandler.fromMethods({});
      Object.defineProperty(hostile, "runs", {
        get() {
          throw new Error("lookup failed");
        },
      });
      const result = await model().invoke([new HumanMessage("Capital of France?")], {
        callbacks: [hostile],
      });
      expect(result.content).toBe("Paris.");
      await finished();
    });

    it("the caller's code between stream chunks does not run under the span", async () => {
      for await (const _ of await model({ streamUsage: true }).stream([
        new HumanMessage("Capital of France?"),
      ])) {
        expect(trace.getActiveSpan()).toBeUndefined();
      }
      expect(trace.getActiveSpan()).toBeUndefined();
      await finished();
    });
  });

  describe("installLangchainSpanContext", () => {
    it("is a no-op on a module without the expected shape", () => {
      expect(() => installLangchainSpanContext(undefined)()).not.toThrow();
      expect(() =>
        installLangchainSpanContext({ BaseChatModel: { prototype: {} } })(),
      ).not.toThrow();
    });

    // Runs last: it takes down the install init() made.
    it("does not stack, and uninstall restores the base class", async () => {
      const chatModels = await import("@langchain/core/language_models/chat_models");
      const base = chatModels.BaseChatModel.prototype as unknown as Record<
        string,
        { [key: symbol]: unknown }
      >;
      const marker = Symbol.for("rius.langchainSpanContext");
      const original = base._generateUncached?.[marker];
      // init() installed once already; installing again wraps the real method,
      // not the wrapper that is there.
      expect(original).toBeTypeOf("function");
      const uninstall = installLangchainSpanContext(
        chatModels as unknown as Parameters<typeof installLangchainSpanContext>[0],
      );
      expect(base._generateUncached?.[marker]).toBe(original);
      uninstall();
      expect(base._generateUncached).toBe(original);
      expect(base._generateUncached?.[marker]).toBeUndefined();
      // The concrete model's own methods, wrapped on first use, are restored too.
      let owner: object | null = ChatOpenAI.prototype;
      while (owner !== null && !Object.hasOwn(owner, "_generate")) {
        owner = Object.getPrototypeOf(owner) as object | null;
      }
      const generate = (owner as Record<string, { [key: symbol]: unknown }> | null)?._generate;
      expect(generate).toBeTypeOf("function");
      expect(generate?.[marker]).toBeUndefined();
    });
  });
});
