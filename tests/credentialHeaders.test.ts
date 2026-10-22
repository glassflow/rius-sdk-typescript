import http from "node:http";
import type { ExportResult } from "@opentelemetry/core";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { getTracer, type InitOptions, init, type RiusClient } from "../src/client.js";
import {
  CredentialHeaderDroppingExporter,
  isCredentialHeaderKey,
} from "../src/credentialHeaders.js";
import { RIUS_SPAN_PENDING } from "../src/semconv.js";

let live: RiusClient | undefined;

function initTracked(options: InitOptions = {}): RiusClient {
  live = init({ heartbeatTransport: async () => {}, ...options });
  return live;
}

afterEach(async () => {
  const client = live;
  live = undefined;
  await client?.shutdown().catch(() => {});
});

describe("isCredentialHeaderKey", () => {
  it.each([
    "ai.request.headers.authorization",
    "ai.request.headers.Authorization",
    "ai.request.headers.proxy-authorization",
    "ai.request.headers.cookie",
    "ai.request.headers.x-api-key",
    "ai.request.headers.api-key",
    "ai.request.headers.x-goog-api-key",
    "ai.request.headers.x-auth-token",
    "ai.request.headers.X-Client-Secret",
    "http.request.header.authorization",
    "http.response.header.set-cookie",
    // OpenTelemetry Python's HTTP instrumentations spell the header with "_".
    "http.request.header.x_api_key",
    "http.response.header.set_cookie",
    // The OpenInference transform's mirror of an untranslated key.
    "metadata.ai.request.headers.authorization",
    // The name is what follows the segment's last occurrence.
    "ai.request.headers.x.headers.authorization",
  ])("drops %s", (key) => {
    expect(isCredentialHeaderKey(key)).toBe(true);
  });

  it.each([
    "ai.request.headers.content-type",
    "ai.request.headers.user-agent",
    "http.request.header.x-forwarded-for",
    // A credential name outside a header segment is someone else's key.
    "authorization",
    "gen_ai.request.model",
    "ai.request.headers",
    // Only a whole hyphen-separated word: "token" alone is not "-token".
    "ai.request.headers.token",
    "ai.request.headers.x-tokens",
  ])("keeps %s", (key) => {
    expect(isCredentialHeaderKey(key)).toBe(false);
  });
});

/** The parts of a span the exporter reads; nothing else is touched. */
function spanWith(attributes: Record<string, unknown>): ReadableSpan {
  return {
    name: "s",
    attributes: { ...attributes },
    events: [{ name: "e", attributes: { ...attributes }, time: [0, 0] }],
    links: [
      {
        context: { traceId: `${"0".repeat(31)}1`, spanId: `${"0".repeat(15)}1`, traceFlags: 1 },
        attributes: { ...attributes },
      },
    ],
  } as unknown as ReadableSpan;
}

describe("CredentialHeaderDroppingExporter", () => {
  it("drops credential headers from attributes, event attributes and link attributes", async () => {
    const inner = new InMemorySpanExporter();
    const exporter = new CredentialHeaderDroppingExporter(inner);
    const span = spanWith({
      "ai.request.headers.authorization": "Bearer sk-secret",
      "ai.request.headers.x-trace": "ok",
    });
    await new Promise<ExportResult>((resolve) => exporter.export([span], resolve));

    const [out] = inner.getFinishedSpans();
    for (const bag of [out.attributes, out.events[0].attributes, out.links[0].attributes]) {
      expect(bag).not.toHaveProperty("ai.request.headers.authorization");
      expect(bag?.["ai.request.headers.x-trace"]).toBe("ok");
    }
  });
});

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
// `ai` v7 and @ai-sdk/otel declare engines node>=22.
const describeV7 = nodeMajor >= 22 ? describe : describe.skip;

const OPENAI_REPLY = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-test",
  choices: [{ index: 0, message: { role: "assistant", content: "4" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
};

/** An HTTP server answering every request with `payload`. */
async function stubServer(payload: unknown): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  return { url: `http://127.0.0.1:${address.port}/v1`, close: () => server.close() };
}

type Bag = { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] };

describeV7("credential headers on real @ai-sdk/otel spans", () => {
  let saved: unknown[] | undefined;
  afterEach(() => {
    (globalThis as Bag).AI_SDK_TELEMETRY_INTEGRATIONS = saved;
  });

  // The app registers @ai-sdk/otel's LegacyOpenTelemetry itself, writing to
  // the global provider Rius holds. That integration writes every header of
  // the call as ai.request.headers.<name>, with no option to turn it off;
  // generateSpeech keeps the caller's spelling of the name.
  it.each([
    { captureContent: false },
    { captureContent: true },
    { captureContent: true, mask: (value: unknown) => value },
  ])("drops Authorization and keeps the other headers (%o)", async (options) => {
    const { generateText, generateSpeech, registerTelemetry } = await import("ai");
    const { createOpenAI } = await import("@ai-sdk/openai");
    const { LegacyOpenTelemetry } = await import("@ai-sdk/otel");

    const inner = new InMemorySpanExporter();
    const client = initTracked({ spanExporter: inner, ...options });
    await client.ready;
    saved = (globalThis as Bag).AI_SDK_TELEMETRY_INTEGRATIONS?.slice();
    registerTelemetry(new LegacyOpenTelemetry());
    const stub = await stubServer(OPENAI_REPLY);
    try {
      const openai = createOpenAI({ apiKey: "not-a-real-key", baseURL: stub.url });
      const headers = { Authorization: "Bearer sk-secret", "X-Trace": "kept" };
      await generateText({ model: openai.chat("gpt-test"), prompt: "what is 2+2", headers });
      await generateSpeech({ model: openai.speech("tts-1"), text: "hi", headers }).catch(
        () => {}, // the stub answers JSON, not audio; the span is all this needs
      );
      await client.flush();
    } finally {
      stub.close();
    }

    const spans = inner.getFinishedSpans();
    const keys = spans.flatMap((s) => Object.keys(s.attributes));
    // The precondition: the integration did write headers onto these spans.
    expect(keys).toContain("ai.request.headers.x-trace");
    expect(keys).toContain("ai.request.headers.X-Trace");
    expect(keys.filter((k) => k.toLowerCase().endsWith(".authorization"))).toEqual([]);
    const serialized = JSON.stringify(spans.map((s) => [s.attributes, s.events, s.links]));
    expect(serialized).not.toContain("sk-secret");
  });
});

describe("credential headers on pending snapshots", () => {
  // gen_ai.request.* rides a pending snapshot as identity, so a header key
  // under it would reach the snapshot through the prefix.
  it.each([false, true])("drops them with captureContent %s", async (captureContent) => {
    const inner = new InMemorySpanExporter();
    const client = initTracked({ spanExporter: inner, partialSpans: true, captureContent });
    await client.ready;
    getTracer()
      .startSpan("s", {
        attributes: {
          "gen_ai.request.headers.authorization": "Bearer sk-secret",
          "gen_ai.request.model": "gpt-test",
        },
      })
      .end();
    await client.flush();

    const spans = inner.getFinishedSpans();
    const pending = spans.find((s) => s.attributes[RIUS_SPAN_PENDING] === true);
    expect(pending?.attributes["gen_ai.request.model"]).toBe("gpt-test");
    for (const span of spans) {
      expect(span.attributes).not.toHaveProperty("gen_ai.request.headers.authorization");
    }
  });
});
