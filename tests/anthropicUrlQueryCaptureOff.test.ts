import http from "node:http";
import { createRequire } from "node:module";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, type RiusClient } from "../src/client.js";
import { URL_FULL, URL_QUERY } from "../src/semconv.js";
import { isNative, TRACES_ITSELF } from "./anthropicMessages.js";

// A call of the Anthropic SDK's with a query parameter the SDK treats as
// content (a memory list's path_prefix), run in the SDK's content mode, with
// Rius set to capture no content. The SDK writes the query to url.query and
// url.full on its own span; neither may carry it out of the process, and the
// span keeps the rest of its URL.
//
// A file of its own: the OpenInference packages keep module-level patch state,
// and vitest's per-file module isolation keeps that state to this file.

const require = createRequire(import.meta.url);

const SECRET = "SECRET-PATH-PREFIX-3a7f";
const STORE = "memstore_1";

interface MemoriesClient {
  beta: {
    memoryStores: {
      memories: { list(store: string, params: { path_prefix: string }): Promise<unknown> };
    };
  };
}

const Anthropic = (
  require("@anthropic-ai/sdk") as {
    default: new (options: {
      apiKey: string;
      baseURL: string;
      maxRetries: number;
      openTelemetry?: { traces: { contentMode: "content" | "metadata_only" } };
    }) => MemoriesClient;
  }
).default;

/** Answers every request with an empty page. */
async function emptyPageServer(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [], next_page: null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

let exporter: InMemorySpanExporter;
let rius: RiusClient;
let server: { url: string; close: () => void };

beforeAll(async () => {
  exporter = new InMemorySpanExporter();
  rius = init({ spanExporter: exporter, heartbeat: false, captureContent: false });
  await rius.ready;
  server = await emptyPageServer();
});

afterAll(async () => {
  server.close();
  await rius.shutdown();
});

describe("the Anthropic SDK's URL query in its content mode, with captureContent off", () => {
  it.runIf(TRACES_ITSELF)("exports the call's URL without its query", async () => {
    const client = new Anthropic({
      apiKey: "not-a-real-key",
      baseURL: server.url,
      maxRetries: 0,
      openTelemetry: { traces: { contentMode: "content" } },
    });

    exporter.reset();
    await client.beta.memoryStores.memories.list(STORE, { path_prefix: SECRET });
    await rius.flush();
    const spans = exporter.getFinishedSpans();

    const native = spans.filter(isNative);
    expect(native).toHaveLength(1);
    const { attributes } = native[0];
    expect(attributes[URL_QUERY]).toBeUndefined();
    expect(attributes[URL_FULL]).toBe(`${server.url}/v1/memory_stores/${STORE}/memories`);
    for (const span of spans) {
      expect(JSON.stringify(span.attributes), span.name).not.toContain(SECRET);
    }
  });
});
