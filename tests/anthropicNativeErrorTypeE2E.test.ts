import http from "node:http";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, type RiusClient } from "../src/client.js";
import { ERROR_TYPE, GEN_AI_OPERATION_NAME } from "../src/semconv.js";
import { Anthropic, isNative, REQUEST, TRACES_ITSELF } from "./anthropicMessages.js";

// A failed Anthropic call with the OpenInference Anthropic instrumentation
// off, so the Anthropic SDK's own span is the only record of it. That SDK names
// the error by the API's error code (not_found_error); Rius must export it
// under the exception class, as the instrumentation's span would have.
//
// A file of its own: the OpenInference packages keep module-level patch state,
// and vitest's per-file module isolation keeps that state to this file.

/** Answers every request with `status` and the Messages API's error envelope of `type`. */
async function failingServer(
  status: number,
  type: string,
): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type, message: "no" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

let exporter: InMemorySpanExporter;
let rius: RiusClient;

beforeAll(async () => {
  exporter = new InMemorySpanExporter();
  // No integration enabled, so the Anthropic SDK is traced by its own spans alone.
  rius = init({ spanExporter: exporter, heartbeat: false, instruments: [] });
  expect(await rius.ready).toEqual([]);
});

afterAll(async () => {
  await rius.shutdown();
});

async function nativeSpanOf(status: number, type: string): Promise<ReadableSpan> {
  const server = await failingServer(status, type);
  try {
    exporter.reset();
    const anthropic = new Anthropic({
      apiKey: "not-a-real-key",
      baseURL: server.url,
      maxRetries: 0,
    });
    await expect(anthropic.messages.create(REQUEST)).rejects.toThrow();
    await rius.flush();
  } finally {
    server.close();
  }
  const spans = exporter.getFinishedSpans();
  // No OpenInference span: the SDK's own is the call's only record.
  expect(spans.map((s) => s.instrumentationScope.name)).not.toContain(
    "@arizeai/openinference-instrumentation-anthropic",
  );
  const native = spans.filter(isNative);
  expect(native).toHaveLength(1);
  // Not demoted, so this is the path without the instrumentation.
  expect(native[0].attributes[GEN_AI_OPERATION_NAME]).toBe("chat");
  return native[0];
}

describe.runIf(TRACES_ITSELF)("the Anthropic SDK's own span of a failed call", () => {
  it.each([
    [404, "not_found_error", "anthropic.NotFoundError"],
    [429, "rate_limit_error", "anthropic.RateLimitError"],
  ])("names a %i by the exception class", async (status, type, expected) => {
    const span = await nativeSpanOf(status, type);
    expect(span.attributes["http.response.status_code"]).toBe(status);
    expect(span.attributes[ERROR_TYPE]).toBe(expected);
  });

  it("keeps the SDK's own value for a status whose class differs by client", async () => {
    const span = await nativeSpanOf(529, "overloaded_error");
    expect(span.attributes[ERROR_TYPE]).toBe("overloaded_error");
  });
});
