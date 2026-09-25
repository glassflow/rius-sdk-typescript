import http from "node:http";
import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { ERROR_TYPE, EXCEPTION_EVENT } from "../src/semconv.js";

// The ESM half of openaiRejectedCall.test.ts. It matters on its own: only when
// the app's `openai` is the same build the instrumentation imported does the
// instrumentation recognise the returned APIPromise and re-parse the raw
// response through `_thenUnwrap`. There, observing the APIPromise itself (its
// `then` parses too) would read the body twice and fail every SUCCESSFUL call,
// which is why the guard observes the unparsed `responsePromise` instead.
//
// Nothing here requires `openai` through CJS, so init() patches the ESM build,
// the one the dynamic import below returns. A file of its own for the
// OpenInference module-level patch state.

let status = 404;
const BODIES: Record<number, unknown> = {
  404: { error: { message: "no such model", type: "invalid_request_error" } },
  200: {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o-2024-08-06",
    choices: [
      { index: 0, finish_reason: "stop", message: { role: "assistant", content: "hello" } },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  },
};

let srv: http.Server;
let url: string;
let exporter: InMemorySpanExporter;
let client: RiusClient;

beforeAll(async () => {
  srv = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(BODIES[status]));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const address = srv.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  url = `http://127.0.0.1:${address.port}`;
  exporter = new InMemorySpanExporter();
  client = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
  expect(await client.ready).toContain("openai");
});

afterAll(async () => {
  await client.shutdown();
  srv.close();
});

async function openai() {
  const { OpenAI } = await import("openai");
  return new OpenAI({ apiKey: "not-a-real-key", baseURL: url, maxRetries: 0 });
}

describe("the ESM build", () => {
  it("ends a rejected call's span as an ERROR", async () => {
    exporter.reset();
    status = 404;
    const oai = await openai();
    await expect(
      oai.chat.completions.create({
        model: "gpt-nope",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("no such model");
    await client.flush();
    const llm = exporter.getFinishedSpans().find((s) => s.name === "OpenAI Chat Completions");
    expect(llm?.status.code).toBe(SpanStatusCode.ERROR);
    expect(llm?.attributes[ERROR_TYPE]).toBe("openai.NotFoundError");
  });

  it("still returns a successful call's parsed body, and ends the span OK", async () => {
    exporter.reset();
    status = 200;
    const oai = await openai();
    const result = await oai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.choices[0]?.message.content).toBe("hello");
    await client.flush();
    const llm = exporter.getFinishedSpans().find((s) => s.name === "OpenAI Chat Completions");
    expect(llm?.status.code).toBe(SpanStatusCode.OK);
    expect(llm?.events.filter((e) => e.name === EXCEPTION_EVENT)).toHaveLength(0);
  });
});
