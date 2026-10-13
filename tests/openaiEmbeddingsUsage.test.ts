import http from "node:http";
import { createRequire } from "node:module";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { GEN_AI_USAGE_INPUT_TOKENS } from "../src/semconv.js";

// Token counts on an OpenAI embeddings call, end to end: a real OpenAI client
// against a local server, auto-instrumented by the OpenInference package
// init() enables, exported through the SDK's pipeline. The instrumentation
// records no usage on embeddings, so without the SDK's own wrapper these spans
// carry no gen_ai.usage.input_tokens and the call is never priced.
//
// A file of its own: the OpenInference packages keep module-level patch state,
// and vitest's per-file module isolation keeps that state to this file.

const require = createRequire(import.meta.url);

interface OpenAIClient {
  embeddings: { create(body: unknown): Promise<unknown> };
}
interface OpenAIModule {
  OpenAI: new (options: { apiKey: string; baseURL: string; maxRetries: number }) => OpenAIClient;
}

// Required before init(), as most applications load it.
const openaiModule = require("openai") as OpenAIModule;

const EMBEDDINGS = {
  object: "list",
  data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
  model: "text-embedding-3-small",
  usage: { prompt_tokens: 5, total_tokens: 5 },
};

async function server(): Promise<{ url: string; close: () => void }> {
  const srv = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(EMBEDDINGS));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const address = srv.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  return { url: `http://127.0.0.1:${address.port}`, close: () => srv.close() };
}

let mock: { url: string; close: () => void };

beforeAll(async () => {
  mock = await server();
});

afterAll(() => {
  mock.close();
});

function embeddingSpan(spans: ReadableSpan[]): ReadableSpan | undefined {
  return spans.find((s) => s.attributes["openinference.span.kind"] === "EMBEDDING");
}

/** init() with `options`, run `call` against the mock, shut down; the embedding span. */
async function embedWith(
  options: { captureContent?: boolean },
  call: (openai: OpenAIClient) => Promise<unknown>,
): Promise<ReadableSpan | undefined> {
  const exporter = new InMemorySpanExporter();
  const client: RiusClient = init({
    spanExporter: exporter,
    heartbeatTransport: async () => {},
    ...options,
  });
  try {
    expect(await client.ready).toContain("openai");
    const openai = new openaiModule.OpenAI({
      apiKey: "not-a-real-key",
      baseURL: mock.url,
      maxRetries: 0,
    });
    await call(openai);
    await client.flush();
    return embeddingSpan(exporter.getFinishedSpans());
  } finally {
    await client.shutdown();
  }
}

const embed = (openai: OpenAIClient) =>
  openai.embeddings.create({ model: "text-embedding-3-small", input: "hello" });

describe("OpenAI embeddings usage", () => {
  it("reaches the backend as gen_ai.usage.input_tokens", async () => {
    const span = await embedWith({}, embed);
    expect(span).toBeDefined();
    expect(span?.attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(5);
  });

  it("is kept with content capture off: counts are not content", async () => {
    const span = await embedWith({ captureContent: false }, embed);
    expect(span?.attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(5);
    // And the content really is gone, so the counts did not ride along with it.
    expect(span?.attributes["input.value"]).toBeUndefined();
  });

  it("hands the caller the client's response unchanged", async () => {
    let returned: unknown;
    await embedWith({}, async (openai) => {
      returned = await embed(openai);
    });
    // The client decodes the vectors itself (it asks for base64), so only what
    // it passes through as-is is compared.
    expect(returned).toMatchObject({ model: EMBEDDINGS.model, usage: EMBEDDINGS.usage });
  });

  it("survives a re-init: the next client records the counts too", async () => {
    const first = await embedWith({}, embed);
    const second = await embedWith({}, embed);
    expect(first?.attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(5);
    expect(second?.attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(5);
  });
});
