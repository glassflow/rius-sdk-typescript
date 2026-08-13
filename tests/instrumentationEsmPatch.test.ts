import http from "node:http";
import { createRequire } from "node:module";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import { enableInstrumentations } from "../src/instrumentation.js";

// The ESM half of the dual-build behaviour: nothing in this file requires the
// provider SDKs through CJS before enabling, so the entries must decide "no
// CJS build in use" and patch the ESM builds. It lives in its own file because
// OpenInference keeps a process-global patched flag per package — one patch
// per file is all we get, and the CJS-first scenario owns
// instrumentationProviders.test.ts.

function makeSink() {
  return { add: vi.fn(), addFirst: vi.fn() };
}

function recordingProvider() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { exporter, provider };
}

async function stubServer(payload: object): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

/** A Chat Completions response shaped as the OpenAI API returns one. */
const OPENAI_REPLY = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-test",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "4" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
};

describe("the openai entry in a pure-ESM consumer", () => {
  it("patches the ESM build and turns a real client call into an LLM span", async () => {
    const { exporter, provider } = recordingProvider();
    const enabled = await enableInstrumentations(makeSink(), provider, ["openai"]);
    expect(enabled).toContain("openai");

    // Imported the way a pure-ESM app does, and never require()d anywhere in
    // this file: before the dual-build handling this import came back
    // untouched, because the require hook never sees ESM importers.
    const { isWrapped } = await import("@opentelemetry/instrumentation");
    const oai = await import("openai");
    const OpenAI = (oai.OpenAI ?? oai.default) as typeof import("openai").OpenAI;
    expect(isWrapped(OpenAI.Chat.Completions.prototype.create)).toBe(true);

    const stub = await stubServer(OPENAI_REPLY);
    try {
      const client = new OpenAI({ apiKey: "not-a-real-key", baseURL: stub.url });
      const reply = await client.chat.completions.create({
        model: "gpt-test",
        messages: [{ role: "user", content: "what is 2+2" }],
      });
      expect(reply.choices[0]?.message?.content).toBe("4");
    } finally {
      stub.close();
    }

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    const attributes = spans[0]?.attributes ?? {};
    expect(attributes["openinference.span.kind"]).toBe("LLM");
    expect(attributes["llm.model_name"]).toBe("gpt-test");
    expect(attributes["llm.input_messages.0.message.content"]).toBe("what is 2+2");
    expect(attributes["llm.token_count.prompt"]).toBe(5);
  });
});

describe("the anthropic entry in a pure-ESM consumer", () => {
  it("patches the ESM build, and the flag leaves a later CJS require unpatched", async () => {
    const { provider } = recordingProvider();
    const enabled = await enableInstrumentations(makeSink(), provider, ["anthropic"]);
    expect(enabled).toContain("anthropic");

    const { isWrapped } = await import("@opentelemetry/instrumentation");
    const esm = await import("@anthropic-ai/sdk");
    const EsmAnthropic = (esm.default ?? esm.Anthropic) as {
      Messages: { prototype: { create: unknown } };
    };
    expect(isWrapped(EsmAnthropic.Messages.prototype.create)).toBe(true);

    // Documents the residual gap, not an aspiration: OpenInference's global
    // patched flag (Arize-ai/openinference#3557) means the CJS build of the
    // same package can no longer be patched in this process. A CJS require
    // that only happens after init() therefore stays uninstrumented. If this
    // assertion starts failing after an OpenInference upgrade, the upstream
    // fix landed: patch BOTH builds unconditionally and drop the
    // cache-checking heuristic.
    const cjs = createRequire(import.meta.url)("@anthropic-ai/sdk") as {
      default?: { Messages: { prototype: { create: unknown } } };
      Anthropic?: { Messages: { prototype: { create: unknown } } };
    };
    const CjsAnthropic = cjs.default ?? cjs.Anthropic;
    expect(CjsAnthropic).toBeDefined();
    expect(EsmAnthropic).not.toBe(CjsAnthropic);
    expect(isWrapped(CjsAnthropic?.Messages.prototype.create)).toBe(false);
  });
});
