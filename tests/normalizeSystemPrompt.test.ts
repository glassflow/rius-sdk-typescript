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
import { NormalizingSpanProcessor, promoteSystemInstruction } from "../src/normalize.js";
import { GEN_AI_INPUT_MESSAGES, LLM_INVOCATION_PARAMETERS } from "../src/semconv.js";

/**
 * The request's `system` member promoted out of the OpenInference request bag
 * into a system input message.
 *
 * The OpenInference Anthropic instrumentation (JS) records the request body
 * minus `messages` as `llm.invocation_parameters`, so Anthropic's top-level
 * `system` prompt, a string or a block list, stays in the bag and never
 * becomes a message; context attribution then books it as unattributed. The
 * Python instrumentor emits it as a message, and the sink applies this same
 * rule to foreign JS traffic.
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

const USER = { role: "user", parts: [{ type: "text", content: "hi" }] };

describe("a string system prompt", () => {
  it("becomes the first input message and leaves the bag", () => {
    const out = normalized({
      [GEN_AI_INPUT_MESSAGES]: JSON.stringify([USER]),
      [LLM_INVOCATION_PARAMETERS]: JSON.stringify({ system: "Be brief.", metadata: { a: 1 } }),
    });
    expect(out[GEN_AI_INPUT_MESSAGES]).toBe(
      JSON.stringify([{ role: "system", parts: [{ type: "text", content: "Be brief." }] }, USER]),
    );
    expect(JSON.parse(out[LLM_INVOCATION_PARAMETERS] as string)).toEqual({ metadata: { a: 1 } });
  });

  it("drops a bag it empties", () => {
    const out = normalized({
      [GEN_AI_INPUT_MESSAGES]: JSON.stringify([USER]),
      [LLM_INVOCATION_PARAMETERS]: JSON.stringify({ system: "Be brief." }),
    });
    expect(Object.hasOwn(out, LLM_INVOCATION_PARAMETERS)).toBe(false);
  });

  it("is promoted from the flattened OpenInference messages too", () => {
    const out = normalized({
      "llm.input_messages.0.message.role": "user",
      "llm.input_messages.0.message.content": "hi",
      [LLM_INVOCATION_PARAMETERS]: JSON.stringify({ system: "Be brief." }),
    });
    expect(JSON.parse(out[GEN_AI_INPUT_MESSAGES] as string)).toEqual([
      { role: "system", parts: [{ type: "text", content: "Be brief." }] },
      USER,
    ]);
  });

  it("creates the messages when the span has none", () => {
    const out = normalized({
      [LLM_INVOCATION_PARAMETERS]: JSON.stringify({ system: "Be brief." }),
    });
    expect(out[GEN_AI_INPUT_MESSAGES]).toBe(
      JSON.stringify([{ role: "system", parts: [{ type: "text", content: "Be brief." }] }]),
    );
  });
});

describe("a block-list system prompt", () => {
  it("is one system message with a text part per text block, cache_control dropped", () => {
    const out = normalized({
      [GEN_AI_INPUT_MESSAGES]: JSON.stringify([USER]),
      [LLM_INVOCATION_PARAMETERS]: JSON.stringify({
        max_tokens: 5,
        system: [
          { type: "text", text: "You are an agent." },
          { type: "text", text: "Long cached context.", cache_control: { type: "ephemeral" } },
        ],
      }),
    });
    expect(JSON.parse(out[GEN_AI_INPUT_MESSAGES] as string)).toEqual([
      {
        role: "system",
        parts: [
          { type: "text", content: "You are an agent." },
          { type: "text", content: "Long cached context." },
        ],
      },
      USER,
    ]);
    // max_tokens was promoted by the table, system by this pass: nothing is left.
    expect(Object.hasOwn(out, LLM_INVOCATION_PARAMETERS)).toBe(false);
    expect(out["gen_ai.request.max_tokens"]).toBe(5);
  });

  it("carries any other block as its compact JSON, keys sorted at every depth", () => {
    const out = normalized({
      [LLM_INVOCATION_PARAMETERS]: JSON.stringify({
        system: [
          { type: "image", source: { url: "u", type: "url" } },
          { type: "text", text: 7 },
          "bare",
        ],
      }),
    });
    const [system] = JSON.parse(out[GEN_AI_INPUT_MESSAGES] as string);
    expect(system.parts).toEqual([
      { type: "text", content: '{"source":{"type":"url","url":"u"},"type":"image"}' },
      { type: "text", content: '{"text":7,"type":"text"}' },
      { type: "text", content: '"bare"' },
    ]);
  });

  it("escapes nothing JSON does not require", () => {
    const out = normalized({
      [LLM_INVOCATION_PARAMETERS]: JSON.stringify({ system: [{ type: "x", v: "<&>é" }] }),
    });
    const [system] = JSON.parse(out[GEN_AI_INPUT_MESSAGES] as string);
    expect(system.parts[0].content).toBe('{"type":"x","v":"<&>é"}');
  });

  it("leaves U+2028/U+2029 raw and replaces a lone surrogate, as the sink's shared encoder does", () => {
    const out = normalized({
      [LLM_INVOCATION_PARAMETERS]: JSON.stringify({ system: [{ v: "a\u2028b\u2029\ud800c" }] }),
    });
    const raw = out[GEN_AI_INPUT_MESSAGES] as string;
    // Raw in the stored attribute too: the messages are the shared encoding.
    expect(raw).toContain("\u2028");
    expect(raw).not.toContain("\\u2028");
    const [system] = JSON.parse(raw);
    expect(system.parts[0].content).toBe('{"v":"a\u2028b\u2029\ufffdc"}');
  });
});

describe("left alone", () => {
  it("when the span already has a system message", () => {
    const messages = JSON.stringify([
      { role: "system", parts: [{ type: "text", content: "native" }] },
      USER,
    ]);
    const bag = JSON.stringify({ system: "Be brief." });
    const out = normalized({ [GEN_AI_INPUT_MESSAGES]: messages, [LLM_INVOCATION_PARAMETERS]: bag });
    expect(out[GEN_AI_INPUT_MESSAGES]).toBe(messages);
    expect(out[LLM_INVOCATION_PARAMETERS]).toBe(bag);
  });

  it.each([
    ["an object", { a: 1 }],
    ["a number", 3],
    ["null", null],
    ["an empty string", ""],
    ["an empty list", []],
  ])("when system is %s", (_name, system) => {
    const bag = JSON.stringify({ system });
    const out = normalized({
      [GEN_AI_INPUT_MESSAGES]: JSON.stringify([USER]),
      [LLM_INVOCATION_PARAMETERS]: bag,
    });
    expect(out[GEN_AI_INPUT_MESSAGES]).toBe(JSON.stringify([USER]));
    expect(out[LLM_INVOCATION_PARAMETERS]).toBe(bag);
  });

  it("when the messages are JSON but not an array", () => {
    const bag = JSON.stringify({ system: "Be brief." });
    const out = normalized({
      [GEN_AI_INPUT_MESSAGES]: '{"a":1}',
      [LLM_INVOCATION_PARAMETERS]: bag,
    });
    expect(out[GEN_AI_INPUT_MESSAGES]).toBe('{"a":1}');
    expect(out[LLM_INVOCATION_PARAMETERS]).toBe(bag);
  });

  it("when the messages are not a JSON array", () => {
    const bag = JSON.stringify({ system: "Be brief." });
    const out = normalized({
      [GEN_AI_INPUT_MESSAGES]: "not json",
      [LLM_INVOCATION_PARAMETERS]: bag,
    });
    expect(out[GEN_AI_INPUT_MESSAGES]).toBe("not json");
    expect(out[LLM_INVOCATION_PARAMETERS]).toBe(bag);
  });

  it("when the bag is not a JSON object", () => {
    expect(promoteSystemInstruction({ [LLM_INVOCATION_PARAMETERS]: "[1]" })).toBe(false);
    expect(promoteSystemInstruction({ [LLM_INVOCATION_PARAMETERS]: "{" })).toBe(false);
    expect(promoteSystemInstruction({})).toBe(false);
  });
});

describe("with content capture off", () => {
  it("masks the promoted system message like any message", async () => {
    const spans = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [
        new NormalizingSpanProcessor(),
        new SimpleSpanProcessor(new MaskingSpanExporter(spans, { captureContent: false })),
      ],
    });
    provider
      .getTracer("t")
      .startSpan("llm", {
        attributes: {
          "openinference.span.kind": "LLM",
          [LLM_INVOCATION_PARAMETERS]: JSON.stringify({ system: "SECRET-SYSTEM-PROMPT" }),
        },
      })
      .end();
    await provider.forceFlush();
    const [span] = spans.getFinishedSpans();
    expect(span).toBeDefined();
    expect(JSON.stringify(span?.attributes)).not.toContain("SECRET-SYSTEM-PROMPT");
    await provider.shutdown();
  });
});

describe("never at span start", () => {
  it("leaves the bag's system member for the end-of-span pass", () => {
    const bag: Record<string, AttributeValue> = {
      [LLM_INVOCATION_PARAMETERS]: JSON.stringify({ system: "Be brief." }),
    };
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
    // Messages are content: they must never ride a pending snapshot.
    expect(bag[GEN_AI_INPUT_MESSAGES]).toBeUndefined();
    expect(JSON.parse(bag[LLM_INVOCATION_PARAMETERS] as string)).toEqual({ system: "Be brief." });
  });
});

// End to end: a real Anthropic client, auto-instrumented by the OpenInference
// package init() enables, against a local server.
const require = createRequire(import.meta.url);
const Anthropic = (
  require("@anthropic-ai/sdk") as {
    default: new (options: { apiKey: string; baseURL: string; maxRetries: number }) => {
      messages: { create(body: unknown): Promise<unknown> };
    };
  }
).default;

const REPLY = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 6524, output_tokens: 1 },
};

let server: { url: string; close: () => void };
let exporter: InMemorySpanExporter;
let client: RiusClient;

beforeAll(async () => {
  const s = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(REPLY));
    });
  });
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const address = s.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  server = { url: `http://127.0.0.1:${address.port}`, close: () => s.close() };
  exporter = new InMemorySpanExporter();
  client = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
  expect(await client.ready).toContain("anthropic");
});

afterAll(async () => {
  await client.shutdown();
  server.close();
});

async function llmSpanFor(system: unknown): Promise<ReadableSpan | undefined> {
  exporter.reset();
  const anthropic = new Anthropic({ apiKey: "k", baseURL: server.url, maxRetries: 0 });
  await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 16,
    system,
    messages: [{ role: "user", content: "hi" }],
  });
  await client.flush();
  return exporter.getFinishedSpans().find((s) => s.attributes["openinference.span.kind"] === "LLM");
}

describe("an auto-instrumented Anthropic call", () => {
  it("carries a string system prompt as the first input message", async () => {
    const span = await llmSpanFor("You are a careful agent.");
    const messages = JSON.parse(span?.attributes[GEN_AI_INPUT_MESSAGES] as string);
    expect(messages[0]).toEqual({
      role: "system",
      parts: [{ type: "text", content: "You are a careful agent." }],
    });
    expect(messages[1].role).toBe("user");
    expect(span?.attributes[LLM_INVOCATION_PARAMETERS] ?? "").not.toContain("careful agent");
  });

  it("carries a cached block-list system prompt, cache_control dropped", async () => {
    const span = await llmSpanFor([
      { type: "text", text: "Rules.", cache_control: { type: "ephemeral" } },
    ]);
    const messages = JSON.parse(span?.attributes[GEN_AI_INPUT_MESSAGES] as string);
    expect(messages[0]).toEqual({ role: "system", parts: [{ type: "text", content: "Rules." }] });
    expect(span?.attributes[LLM_INVOCATION_PARAMETERS] ?? "").not.toContain("system");
  });
});
