import http from "node:http";
import { createRequire } from "node:module";
import type { AttributeValue, Attributes } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { MaskingSpanExporter } from "../src/masking.js";
import { NormalizingSpanProcessor } from "../src/normalize.js";
import { GEN_AI_REQUEST_MODEL, GEN_AI_RESPONSE_ID, OUTPUT_VALUE } from "../src/semconv.js";

/**
 * Two OpenInference facts the table did not map, with the same contract as the
 * Python SDK: the embedding model and its vectors, and the response id an LLM
 * span only carries inside its `output.value` payload.
 */

/** The shipped processor over one bag at onEnd; the mutated bag comes back. */
function normalized(input: Attributes): Record<string, AttributeValue | undefined> {
  const attributes: Attributes = { ...input };
  new NormalizingSpanProcessor().onEnd({
    attributes,
    events: [],
    status: { code: SpanStatusCode.UNSET },
    startTime: [0, 0],
  } as unknown as ReadableSpan);
  return attributes;
}

function present(attributes: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(attributes, key) && attributes[key] !== undefined;
}

describe("embedding.model_name", () => {
  it("becomes gen_ai.request.model and leaves", () => {
    const out = normalized({
      "openinference.span.kind": "EMBEDDING",
      "embedding.model_name": "text-embedding-3-small",
    });
    expect(out[GEN_AI_REQUEST_MODEL]).toBe("text-embedding-3-small");
    expect(present(out, "embedding.model_name")).toBe(false);
  });

  it("loses to a native model, and still leaves", () => {
    const out = normalized({
      [GEN_AI_REQUEST_MODEL]: "native",
      "embedding.model_name": "text-embedding-3-small",
    });
    expect(out[GEN_AI_REQUEST_MODEL]).toBe("native");
    expect(present(out, "embedding.model_name")).toBe(false);
  });

  it("maps nothing from an empty or non-string name", () => {
    for (const value of ["", 3]) {
      const out = normalized({ "embedding.model_name": value });
      expect(present(out, GEN_AI_REQUEST_MODEL)).toBe(false);
      expect(out["embedding.model_name"]).toBe(value);
    }
  });

  it("is mapped at span start, so a pending snapshot carries the model", () => {
    const bag: Record<string, AttributeValue> = { "embedding.model_name": "m" };
    new NormalizingSpanProcessor().onStart(
      {
        attributes: bag,
        setAttribute(key: string, value: AttributeValue) {
          bag[key] = value;
          return this;
        },
        recordException() {},
      } as never,
      {} as never,
    );
    expect(bag[GEN_AI_REQUEST_MODEL]).toBe("m");
    expect(present(bag, "embedding.model_name")).toBe(false);
  });
});

describe("embedding vectors", () => {
  it("are dropped, and the texts kept", () => {
    const out = normalized({
      "openinference.span.kind": "EMBEDDING",
      "embedding.embeddings.0.embedding.vector": [0.1, 0.2],
      "embedding.embeddings.1.embedding.vector": [0.3],
      "embedding.embeddings.0.embedding.text": "a",
      "embedding.embeddings.1.embedding.text": "b",
    });
    expect(present(out, "embedding.embeddings.0.embedding.vector")).toBe(false);
    expect(present(out, "embedding.embeddings.1.embedding.vector")).toBe(false);
    expect(out["embedding.embeddings.0.embedding.text"]).toBe("a");
    expect(out["embedding.embeddings.1.embedding.text"]).toBe("b");
  });

  it("reads the index as the message families do: a sign and ASCII digits, within int64", () => {
    const out = normalized({
      "embedding.embeddings.+2.embedding.vector": [1],
      "embedding.embeddings.9223372036854775807.embedding.vector": [1],
    });
    expect(present(out, "embedding.embeddings.+2.embedding.vector")).toBe(false);
    expect(present(out, "embedding.embeddings.9223372036854775807.embedding.vector")).toBe(false);
  });

  it("leaves a key that is not the indexed vector family", () => {
    const kept = {
      "embedding.embeddings.x.embedding.vector": [1],
      "embedding.embeddings.-1.embedding.vector": [1],
      "embedding.embeddings.9223372036854775808.embedding.vector": [1],
      "embedding.embeddings.\u0661.embedding.vector": [1],
      "embedding.embeddings.0.embedding.vector_norm": 1,
    };
    const out = normalized(kept);
    for (const [key, value] of Object.entries(kept)) expect(out[key]).toEqual(value);
  });

  it("an EMBEDDING span's kind and prompt tokens map like an LLM span's", () => {
    const out = normalized({
      "openinference.span.kind": "EMBEDDING",
      "llm.token_count.prompt": 2,
    });
    expect(out["gen_ai.operation.name"]).toBe("embeddings");
    expect(out["gen_ai.usage.input_tokens"]).toBe(2);
  });

  it("lets a request-bag model beat embedding.model_name, which only fills a gap", () => {
    const out = normalized({
      "embedding.model_name": "embed-name",
      "llm.invocation_parameters": JSON.stringify({ model: "bag-model" }),
    });
    expect(out[GEN_AI_REQUEST_MODEL]).toBe("bag-model");
    expect(present(out, "embedding.model_name")).toBe(false);
  });

  it("masks the texts with content capture off", async () => {
    const spans = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [
        new NormalizingSpanProcessor(),
        new SimpleSpanProcessor(new MaskingSpanExporter(spans, { captureContent: false })),
      ],
    });
    provider
      .getTracer("t")
      .startSpan("embed", {
        attributes: {
          "openinference.span.kind": "EMBEDDING",
          "embedding.embeddings.0.embedding.text": "SECRET-EMBEDDED-TEXT",
        },
      })
      .end();
    const [span] = spans.getFinishedSpans();
    expect(JSON.stringify(span?.attributes)).not.toContain("SECRET-EMBEDDED-TEXT");
    await provider.shutdown();
  });
});

describe("gen_ai.response.id from output.value", () => {
  const body = JSON.stringify({ id: "chatcmpl-42", object: "chat.completion", choices: [] });

  it("is the top-level id of an LLM span's JSON output, output.value untouched", () => {
    const out = normalized({ "openinference.span.kind": "LLM", [OUTPUT_VALUE]: body });
    expect(out[GEN_AI_RESPONSE_ID]).toBe("chatcmpl-42");
    expect(out[OUTPUT_VALUE]).toBe(body);
  });

  it("applies to a span the operation name makes an LLM span", () => {
    const out = normalized({ "gen_ai.operation.name": "chat", [OUTPUT_VALUE]: body });
    expect(out[GEN_AI_RESPONSE_ID]).toBe("chatcmpl-42");
  });

  it("is taken from output declared JSON, or undeclared", () => {
    for (const mime of ["application/json", undefined]) {
      const input: Attributes = { "openinference.span.kind": "LLM", [OUTPUT_VALUE]: body };
      if (mime !== undefined) input["output.mime_type"] = mime;
      expect(normalized(input)[GEN_AI_RESPONSE_ID]).toBe("chatcmpl-42");
    }
  });

  it("is not taken from output declared plain text, the model's own words", () => {
    // A streamed reply in JSON mode: the JS instrumentors record the
    // accumulated TEXT, which may be a JSON object with an id of its own.
    const out = normalized({
      "openinference.span.kind": "LLM",
      [OUTPUT_VALUE]: '{"id":"user-123","name":"Ada"}',
      "output.mime_type": "text/plain",
    });
    expect(present(out, GEN_AI_RESPONSE_ID)).toBe(false);
  });

  it("never overrides a native id", () => {
    const out = normalized({
      "openinference.span.kind": "LLM",
      [GEN_AI_RESPONSE_ID]: "native",
      [OUTPUT_VALUE]: body,
    });
    expect(out[GEN_AI_RESPONSE_ID]).toBe("native");
  });

  it.each([
    ["a non-LLM span", { "openinference.span.kind": "CHAIN", [OUTPUT_VALUE]: body }],
    ["a span with no kind", { [OUTPUT_VALUE]: body }],
    ["leading whitespace", { "openinference.span.kind": "LLM", [OUTPUT_VALUE]: ` ${body}` }],
    ["plain text", { "openinference.span.kind": "LLM", [OUTPUT_VALUE]: "chatcmpl-42" }],
    ["a JSON array", { "openinference.span.kind": "LLM", [OUTPUT_VALUE]: '[{"id":"x"}]' }],
    ["broken JSON", { "openinference.span.kind": "LLM", [OUTPUT_VALUE]: '{"id":"x"' }],
    ["an empty id", { "openinference.span.kind": "LLM", [OUTPUT_VALUE]: '{"id":""}' }],
    ["a numeric id", { "openinference.span.kind": "LLM", [OUTPUT_VALUE]: '{"id":7}' }],
    ["a nested id only", { "openinference.span.kind": "LLM", [OUTPUT_VALUE]: '{"a":{"id":"x"}}' }],
  ])("is not derived from %s", (_name, input) => {
    const out = normalized(input as Attributes);
    expect(present(out, GEN_AI_RESPONSE_ID)).toBe(false);
    expect(out[OUTPUT_VALUE]).toBe((input as Attributes)[OUTPUT_VALUE]);
  });

  it("survives content capture off, where output.value does not", async () => {
    const spans = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [
        new NormalizingSpanProcessor(),
        new SimpleSpanProcessor(new MaskingSpanExporter(spans, { captureContent: false })),
      ],
    });
    provider
      .getTracer("t")
      .startSpan("llm", { attributes: { "openinference.span.kind": "LLM", [OUTPUT_VALUE]: body } })
      .end();
    const [span] = spans.getFinishedSpans();
    expect(span?.attributes[GEN_AI_RESPONSE_ID]).toBe("chatcmpl-42");
    expect(span?.attributes[OUTPUT_VALUE]).not.toBe(body);
    await provider.shutdown();
  });
});

// End to end: a real OpenAI client, auto-instrumented by the OpenInference
// package init() enables, against a local server. A file of its own so the
// instrumentation's module-level patch state stays here.
const require = createRequire(import.meta.url);
interface OpenAIClient {
  chat: { completions: { create(body: unknown): Promise<unknown> } };
  embeddings: { create(body: unknown): Promise<unknown> };
}
const OpenAI = (
  require("openai") as {
    OpenAI: new (options: { apiKey: string; baseURL: string; maxRetries: number }) => OpenAIClient;
  }
).OpenAI;

const COMPLETION = {
  id: "chatcmpl-e2e",
  object: "chat.completion",
  created: 1,
  model: "gpt-4o-2024-08-06",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};
const EMBEDDINGS = {
  object: "list",
  model: "text-embedding-3-small",
  data: [
    { object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] },
    { object: "embedding", index: 1, embedding: [0.4, 0.5, 0.6] },
  ],
  usage: { prompt_tokens: 2, total_tokens: 2 },
};

let streamReply = "";
let server: { url: string; close: () => void };
let exporter: InMemorySpanExporter;
let client: RiusClient;

beforeAll(async () => {
  const s = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      if (JSON.parse(raw || "{}").stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: unknown, finish: string | null) =>
          `data: ${JSON.stringify({
            id: "chatcmpl-stream",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-4o-2024-08-06",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        response.end(
          `${chunk({ role: "assistant", content: streamReply }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url?.endsWith("/embeddings") ? EMBEDDINGS : COMPLETION));
    });
  });
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const address = s.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  server = { url: `http://127.0.0.1:${address.port}`, close: () => s.close() };
  exporter = new InMemorySpanExporter();
  client = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
  expect(await client.ready).toContain("openai");
});

afterAll(async () => {
  await client.shutdown();
  server.close();
});

describe("auto-instrumented OpenAI calls", () => {
  it("an embeddings call carries the model and its texts, not its vectors", async () => {
    exporter.reset();
    const openai = new OpenAI({ apiKey: "k", baseURL: server.url, maxRetries: 0 });
    await openai.embeddings.create({ model: "text-embedding-3-small", input: ["a", "b"] });
    await client.flush();
    const span = exporter
      .getFinishedSpans()
      .find((s) => s.attributes["openinference.span.kind"] === "EMBEDDING");
    expect(span).toBeDefined();
    const attributes = (span as ReadableSpan).attributes;
    expect(attributes[GEN_AI_REQUEST_MODEL]).toBe("text-embedding-3-small");
    expect(attributes["embedding.model_name"]).toBeUndefined();
    expect(Object.keys(attributes).filter((k) => k.endsWith(".embedding.vector"))).toEqual([]);
    expect(attributes["embedding.embeddings.0.embedding.text"]).toBe("a");
    expect(attributes["embedding.embeddings.1.embedding.text"]).toBe("b");
    expect(attributes["gen_ai.operation.name"]).toBe("embeddings");
    // The JS OpenAI instrumentation (4.2.x) writes no token count on an
    // embeddings span, unlike the Python one; pinned so an upstream fix shows.
    expect(attributes["llm.token_count.prompt"]).toBeUndefined();
    expect(attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
  });

  it("a chat completion carries the response id", async () => {
    exporter.reset();
    const openai = new OpenAI({ apiKey: "k", baseURL: server.url, maxRetries: 0 });
    await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    await client.flush();
    const span = exporter
      .getFinishedSpans()
      .find((s) => s.attributes["openinference.span.kind"] === "LLM");
    expect(span?.attributes[GEN_AI_RESPONSE_ID]).toBe("chatcmpl-e2e");
  });

  it("a streamed chat completion carries no id: its output.value is the reply text", async () => {
    // Recorded behaviour of the JS instrumentor (4.2.x), which differs from
    // Python's: a stream's output.value is the accumulated content as
    // text/plain, not the serialized completion, so there is no id to take.
    // The reply here is a JSON object with an id, which must not be mistaken
    // for the response's.
    exporter.reset();
    streamReply = '{"id":"user-123"}';
    const openai = new OpenAI({ apiKey: "k", baseURL: server.url, maxRetries: 0 });
    const stream = (await openai.chat.completions.create({
      model: "gpt-4o",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })) as AsyncIterable<unknown>;
    for await (const _chunk of stream) {
      // drain
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await client.flush();
    const span = exporter
      .getFinishedSpans()
      .find((s) => s.attributes["openinference.span.kind"] === "LLM");
    expect(span?.attributes[OUTPUT_VALUE]).toBe('{"id":"user-123"}');
    expect(span?.attributes["output.mime_type"]).toBe("text/plain");
    expect(span?.attributes[GEN_AI_RESPONSE_ID]).toBeUndefined();
  });
});
