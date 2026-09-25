import http from "node:http";
import type { Context } from "@opentelemetry/api";
import type { ExportResult } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  type ReadableSpan,
  type Span,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RiusClient, init, spanProcessorSink } from "../src/client.js";
import { isContentKey } from "../src/masking.js";
import { NormalizingSpanProcessor } from "../src/normalize.js";
import { PendingSpanProcessor } from "../src/pending.js";
import {
  PENDING_IDENTITY_ATTRIBUTES,
  PENDING_IDENTITY_PREFIXES,
  RIUS_SPAN_PENDING,
} from "../src/semconv.js";
import { withSession } from "../src/session.js";

// What a third-party span's pending snapshot can know. The snapshot is built
// from the attributes a span carries at onStart, so only what an integration
// passes into startSpan can ever reach the live view; whatever it sets after
// that lands on the final span only.
//
// The key sets below were recorded on a bare provider, with a processor that
// reads the live span at onStart, from a real call through each path init()
// wires. Every value is one a real call produced.
//
// - openai, anthropic (patchActiveBuild) and langchain (manuallyInstrument):
//   NOTHING. All three create spans through OpenInference's OITracer
//   (@arizeai/openinference-core 2.5.x), whose startSpan starts the span with
//   `attributes: undefined` and only then calls setAttributes, so its trace
//   config can mask them. The kind, the request model (llm.model_name is
//   body.model here) and the provider all arrive right after onStart.
// - Vercel AI SDK v7 through @ai-sdk/otel: GenAI-native from the first
//   moment, operation, provider, request model and tool identity included.
// - Vercel AI SDK v5 and v6 through experimental_telemetry (recorded with ai
//   5.0.266 / @ai-sdk/openai 2.0.130 and ai 6.0.291 / @ai-sdk/openai 3.0.118,
//   which are not dev dependencies, so these two are not re-checked below).
//   The provider-call span carries gen_ai.system and gen_ai.request.*; the
//   ai.* dialect's own identity (ai.operationId, ai.model.id,
//   ai.toolCall.name) is only translated by the OpenInference transform, at
//   onEnd. Both versions produce the same key sets.
const VERCEL_V7_REQUEST = {
  "gen_ai.provider.name": "openai",
  "gen_ai.request.model": "gpt-4o",
  "gen_ai.request.temperature": 0.3,
  "gen_ai.input.messages": '[{"role":"user","parts":[{"type":"text","content":"hi"}]}]',
};
const VERCEL_V5_SHARED = {
  "resource.name": "fn",
  "ai.telemetry.functionId": "fn",
  "ai.telemetry.metadata.team": "search",
};
const VERCEL_V5_CALL = {
  ...VERCEL_V5_SHARED,
  "ai.model.provider": "openai.chat",
  "ai.model.id": "gpt-4o",
  "ai.settings.temperature": 0.3,
  "ai.settings.maxRetries": 2,
  "ai.request.headers.user-agent": "ai/5.0.266",
};

const START_TIME_KEYS: Record<string, Record<string, Record<string, unknown>>> = {
  openai: { "OpenAI Chat Completions": {} },
  anthropic: { "Anthropic Messages": {} },
  langchain: { FakeListChatModel: {}, weather: {} },
  "vercel v7": {
    invoke_agent: { "gen_ai.operation.name": "invoke_agent", ...VERCEL_V7_REQUEST },
    step: { "gen_ai.operation.name": "agent_step" },
    chat: {
      "gen_ai.operation.name": "chat",
      ...VERCEL_V7_REQUEST,
      "gen_ai.tool.definitions": '[{"type":"function","name":"get_weather"}]',
    },
    execute_tool: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "get_weather",
      "gen_ai.tool.call.id": "call_1",
      "gen_ai.tool.type": "function",
      "gen_ai.tool.call.arguments": '{"city":"x"}',
    },
  },
  "vercel v5/v6": {
    "ai.generateText": {
      "operation.name": "ai.generateText fn",
      "ai.operationId": "ai.generateText",
      ...VERCEL_V5_CALL,
      "ai.prompt": '{"prompt":"hi"}',
    },
    "ai.generateText.doGenerate": {
      "operation.name": "ai.generateText.doGenerate fn",
      "ai.operationId": "ai.generateText.doGenerate",
      ...VERCEL_V5_CALL,
      "ai.prompt.messages": '[{"role":"user","content":[{"type":"text","text":"hi"}]}]',
      "ai.prompt.tools": ['{"type":"function","name":"get_weather"}'],
      "ai.prompt.toolChoice": '{"type":"auto"}',
      "gen_ai.system": "openai.chat",
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.request.temperature": 0.3,
    },
    "ai.toolCall": {
      "operation.name": "ai.toolCall fn",
      "ai.operationId": "ai.toolCall",
      ...VERCEL_V5_SHARED,
      "ai.toolCall.name": "get_weather",
      "ai.toolCall.id": "call_1",
      "ai.toolCall.args": '{"city":"x"}',
    },
  },
};

/**
 * Keys a path carries at start that are neither allowlisted nor content. Each
 * stays off the snapshot with a stated reason. A key missing from here and
 * from the allowlist fails the structural test, so a new start-time identity
 * key cannot silently miss the live view.
 */
const START_TIME_NOT_IDENTITY: Record<string, string> = {
  // Vercel's display names: the operation id plus the caller's function id.
  "operation.name": "a display label; ai.operationId is the fact",
  "resource.name": "the caller's function id, repeated",
  "ai.telemetry.functionId": "caller-chosen label, not span identity",
  "ai.telemetry.metadata.team": "caller context, free-form",
  "ai.settings.maxRetries": "a client setting, not a model parameter",
  "ai.request.headers.user-agent": "transport detail",
  // The ai.* dialect's identity. The OpenInference Vercel transform
  // translates it, but only at onEnd, and no start-time rule exists for it.
  // The provider-call span still reaches the live view with a request model
  // and provider through the gen_ai.* keys the AI SDK writes alongside.
  "ai.operationId": "Vercel dialect identity; translated at onEnd only",
  "ai.model.id": "Vercel dialect identity; translated at onEnd only",
  "ai.model.provider": "Vercel dialect identity; translated at onEnd only",
  "ai.settings.temperature": "Vercel dialect identity; translated at onEnd only",
  "ai.toolCall.name": "Vercel dialect identity; translated at onEnd only",
  "ai.toolCall.id": "Vercel dialect identity; translated at onEnd only",
  "ai.prompt.toolChoice": "Vercel dialect request detail; translated at onEnd only",
};

/**
 * What each span's snapshot carries once the start-time rules have run. The
 * three OpenInference paths carry nothing, and not by our choice: nothing is
 * on the span yet when the snapshot is taken.
 */
const START_TIME_IDENTITY: Record<string, Record<string, Record<string, unknown>>> = {
  openai: { "OpenAI Chat Completions": {} },
  anthropic: { "Anthropic Messages": {} },
  langchain: { FakeListChatModel: {}, weather: {} },
  "vercel v7": {
    invoke_agent: {
      "gen_ai.operation.name": "invoke_agent",
      "openinference.span.kind": "AGENT",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.request.temperature": 0.3,
    },
    step: { "gen_ai.operation.name": "agent_step" },
    chat: {
      "gen_ai.operation.name": "chat",
      "openinference.span.kind": "LLM",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.request.temperature": 0.3,
    },
    execute_tool: {
      "gen_ai.operation.name": "execute_tool",
      "openinference.span.kind": "TOOL",
      "gen_ai.tool.name": "get_weather",
      "gen_ai.tool.call.id": "call_1",
      "gen_ai.tool.type": "function",
    },
  },
  "vercel v5/v6": {
    "ai.generateText": {},
    "ai.generateText.doGenerate": {
      // The AI SDK's gen_ai.system is the provider-and-API id, and the
      // provider rule passes it through verbatim. The same value wins at
      // onEnd, since the transform writes no llm.provider for it.
      "gen_ai.provider.name": "openai.chat",
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.request.temperature": 0.3,
    },
    "ai.toolCall": {},
  },
};

class Snapshots implements SpanProcessor {
  readonly spans: ReadableSpan[] = [];
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    this.spans.push(span);
  }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

/**
 * The two start-time processors in the order init() adds them, on a bare
 * provider, so the input is raw rather than already normalized.
 */
function barePipeline(): { provider: BasicTracerProvider; snapshots: Snapshots } {
  const snapshots = new Snapshots();
  const provider = new BasicTracerProvider({
    spanProcessors: [new NormalizingSpanProcessor(), new PendingSpanProcessor(snapshots)],
  });
  return { provider, snapshots };
}

function withoutMarker(attributes: Record<string, unknown>): Record<string, unknown> {
  const { [RIUS_SPAN_PENDING]: _marker, ...rest } = attributes;
  return rest;
}

const allowlisted = (key: string): boolean =>
  PENDING_IDENTITY_ATTRIBUTES.has(key) ||
  PENDING_IDENTITY_PREFIXES.some((prefix) => key.startsWith(prefix));

describe("start-time identity of third-party spans", () => {
  const cases = Object.entries(START_TIME_KEYS).flatMap(([path, spans]) =>
    Object.entries(spans).map(([name, attributes]) => ({ path, name, attributes })),
  );

  it.each(cases)(
    "$path / $name: every start key is allowlisted, content, or argued",
    ({ path, name, attributes }) => {
      const { provider, snapshots } = barePipeline();
      const span = provider
        .getTracer("third-party")
        .startSpan(name, { attributes: attributes as Record<string, string> });
      const normalized = { ...(span as unknown as Span).attributes };
      span.end();

      const unaccounted = Object.keys(normalized).filter(
        (key) =>
          !allowlisted(key) && !isContentKey(key) && !Object.hasOwn(START_TIME_NOT_IDENTITY, key),
      );
      expect(
        unaccounted,
        `${path} carries these at span start, but they are neither allowlisted, content, nor argued in START_TIME_NOT_IDENTITY`,
      ).toEqual([]);

      expect(snapshots.spans).toHaveLength(1);
      expect(withoutMarker(snapshots.spans[0]?.attributes ?? {})).toEqual(
        START_TIME_IDENTITY[path]?.[name],
      );
    },
  );

  /**
   * Pins a decision, the same one the Python SDK made: llm.model_name gets no
   * start-time rule.
   *
   * At onStart a model could only be the requested one, since no response
   * exists yet, so a start-only mapping onto gen_ai.request.model would be
   * total where the end-time one is not. It is still declined, because no
   * path puts llm.model_name on a span by onStart (see START_TIME_KEYS): the
   * rule would map nothing that exists. The TypeScript openai instrumentation
   * does write the request model there, but only after OITracer's startSpan
   * has returned. The rule would also have to be kept out of the end-time
   * pass, where the mapping is wrong. The request model reaches the final
   * span from the request bag's `model` member instead. Revisit when an
   * integration starts passing the model at start.
   */
  it("a start-time llm.model_name is not mapped", () => {
    const { provider, snapshots } = barePipeline();
    provider
      .getTracer("third-party")
      .startSpan("call", {
        attributes: { "openinference.span.kind": "LLM", "llm.model_name": "gpt-4o" },
      })
      .end();
    const attributes = snapshots.spans[0]?.attributes ?? {};
    expect(attributes["gen_ai.request.model"]).toBeUndefined();
    expect(attributes["llm.model_name"]).toBeUndefined();
  });
});

// --- Real spans through init() ----------------------------------------------
//
// One client for the whole file. OpenInference keeps a process-global patched
// flag per package, so a file gets one patch per package; vitest's per-file
// module isolation keeps that state here.

class Capture implements SpanExporter {
  readonly spans: ReadableSpan[] = [];
  export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
    for (const s of spans) this.spans.push({ ...s, name: s.name, attributes: { ...s.attributes } });
    cb({ code: 0 });
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

/** Reads the raw attributes at onStart. Added FIRST, ahead of normalization. */
class StartKeys implements SpanProcessor {
  readonly starts: Array<{ name: string; attributes: Record<string, unknown> }> = [];
  onStart(span: Span, _parentContext: Context): void {
    this.starts.push({ name: span.name, attributes: { ...span.attributes } });
  }
  onEnd(): void {}
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

const OPENAI_REPLY = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-4o-2026-08-06",
  choices: [{ index: 0, message: { role: "assistant", content: "4" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
};
const OPENAI_TOOL_CALL = {
  ...OPENAI_REPLY,
  choices: [
    {
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"x"}' },
          },
        ],
      },
    },
  ],
};
const ANTHROPIC_REPLY = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-20260901",
  content: [{ type: "text", text: "4" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 5, output_tokens: 1 },
};

/** A local server answering POSTs with each payload in turn, the last repeated. */
async function stubServer(...payloads: unknown[]): Promise<{ url: string; close: () => void }> {
  let calls = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const payload = payloads[Math.min(calls, payloads.length - 1)];
      calls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

describe("pending snapshots of real third-party spans, through init()", () => {
  let client: RiusClient;
  const exporter = new Capture();
  const recorder = new StartKeys();

  beforeAll(async () => {
    client = init({ spanExporter: exporter, partialSpans: true, heartbeat: false });
    spanProcessorSink(client).addFirst(recorder);
    await client.ready;
  });

  afterAll(async () => {
    await client.shutdown();
    (globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] }).AI_SDK_TELEMETRY_INTEGRATIONS =
      [];
  });

  /** Runs one path's calls, then checks start keys and snapshots against the tables. */
  async function drive(path: string, call: () => Promise<void>): Promise<ReadableSpan[]> {
    exporter.spans.length = 0;
    recorder.starts.length = 0;
    await withSession("sess-1", call);
    await client.flush();

    const expected = START_TIME_KEYS[path] ?? {};
    const pendings = exporter.spans.filter((s) => s.attributes[RIUS_SPAN_PENDING] === true);
    const finals = exporter.spans.filter((s) => s.attributes[RIUS_SPAN_PENDING] !== true);
    for (const name of Object.keys(expected)) {
      // START_TIME_KEYS is evidence, so it must not drift from the
      // integration it describes.
      const started = recorder.starts.find((s) => s.name.startsWith(name));
      expect(started, `${path}: no span named ${name}`).toBeDefined();
      expect(Object.keys(started?.attributes ?? {}).sort()).toEqual(
        Object.keys(expected[name] ?? {}).sort(),
      );
      // The snapshot through the whole pipeline: the start-time identity,
      // plus the session our own processor stamps, and never content.
      const pending = pendings.find((s) => s.name.startsWith(name));
      expect(pending, `${path}: no pending snapshot for ${name}`).toBeDefined();
      const carried = withoutMarker(pending?.attributes ?? {});
      expect(carried).toEqual({ ...START_TIME_IDENTITY[path]?.[name], "session.id": "sess-1" });
      expect(Object.keys(carried).filter(isContentKey)).toEqual([]);
    }
    return finals;
  }

  it("openai via patchActiveBuild: the snapshot has no identity of its own yet", async () => {
    const { default: OpenAI } = await import("openai");
    const stub = await stubServer(OPENAI_REPLY);
    try {
      const finals = await drive("openai", async () => {
        await new OpenAI({
          apiKey: "not-a-real-key",
          baseURL: `${stub.url}/v1`,
        }).chat.completions.create({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
        });
      });
      // Everything arrives right after onStart, so the final span has it.
      const final = finals.find((s) => s.name === "OpenAI Chat Completions");
      expect(final?.attributes["gen_ai.operation.name"]).toBe("chat");
      expect(final?.attributes["gen_ai.request.model"]).toBe("gpt-4o");
    } finally {
      stub.close();
    }
  });

  it("anthropic via patchActiveBuild: the snapshot has no identity of its own yet", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const stub = await stubServer(ANTHROPIC_REPLY);
    try {
      const finals = await drive("anthropic", async () => {
        await new Anthropic({ apiKey: "not-a-real-key", baseURL: stub.url }).messages.create({
          model: "claude-sonnet-5",
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        });
      });
      const final = finals.find((s) => s.name === "Anthropic Messages");
      expect(final?.attributes["gen_ai.provider.name"]).toBe("anthropic");
      expect(final?.attributes["gen_ai.request.model"]).toBe("claude-sonnet-5");
    } finally {
      stub.close();
    }
  });

  // @langchain/core needs globalThis.crypto to run a chain, a global from Node 20.
  it.skipIf(nodeMajor < 20)(
    "langchain via manuallyInstrument: the snapshot has no identity of its own yet",
    async () => {
      const { FakeListChatModel } = await import("@langchain/core/utils/testing");
      const { tool } = await import("@langchain/core/tools");
      const finals = await drive("langchain", async () => {
        await new FakeListChatModel({ responses: ["hi"] }).invoke("hello");
        await tool(async () => "sunny", { name: "weather", description: "w" }).invoke({});
      });
      const final = finals.find((s) => s.name === "FakeListChatModel");
      expect(final?.attributes["openinference.span.kind"]).toBe("LLM");
    },
  );

  // `ai` v7 and @ai-sdk/otel declare engines node>=22.
  it.skipIf(nodeMajor < 22)(
    "vercel v7 via @ai-sdk/otel: kind, operation, request model and provider, no content",
    async () => {
      const { generateText, tool, jsonSchema, stepCountIs } = await import("ai");
      const { createOpenAI } = await import("@ai-sdk/openai");
      const stub = await stubServer(OPENAI_TOOL_CALL, OPENAI_REPLY);
      try {
        await drive("vercel v7", async () => {
          const openai = createOpenAI({ apiKey: "not-a-real-key", baseURL: `${stub.url}/v1` });
          await generateText({
            model: openai.chat("gpt-4o"),
            prompt: "hi",
            temperature: 0.3,
            stopWhen: stepCountIs(3),
            tools: {
              get_weather: tool({
                description: "w",
                inputSchema: jsonSchema({
                  type: "object",
                  properties: { city: { type: "string" } },
                }),
                execute: async () => "sunny",
              }),
            },
          });
        });
      } finally {
        stub.close();
      }
    },
  );
});
