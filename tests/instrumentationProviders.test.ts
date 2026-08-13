import http from "node:http";
import { createRequire } from "node:module";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import { REGISTRY, enableInstrumentations } from "../src/instrumentation.js";

// The Anthropic and LangChain entries are asserted end to end against the real
// packages rather than a stand-in: an entry that loads but instruments nothing
// looks identical to a working one unless a real call comes out as a span.
//
// They live in a file of their own because both OpenInference packages keep
// module-level patch state, so whichever instrumentation instance patched last
// owns the wrapper. Sharing a file with tests that call init(), which registers
// its own instances against its own tracer provider, would make the assertions
// depend on execution order. One file per concern, and vitest's per-file module
// isolation keeps that state to itself.

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

function makeSink() {
  return { add: vi.fn(), addFirst: vi.fn() };
}

/** Records spans through a provider of our own, as init() would. */
function recordingProvider() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { exporter, provider };
}

/** An HTTP server answering every request with `payload`. */
async function stubServer(payload: unknown): Promise<{ url: string; close: () => void }> {
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

/** A Messages response shaped as the Anthropic API returns one. */
const ANTHROPIC_REPLY = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-test",
  content: [{ type: "text", text: "4" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 5, output_tokens: 1 },
};

interface AnthropicModule {
  default: new (options: { apiKey: string; baseURL: string }) => {
    messages: { create(body: unknown): Promise<{ content: { text?: string }[] }> };
  };
}

describe("the anthropic entry", () => {
  it("loads a real instrumentation from the installed package", async () => {
    const entry = REGISTRY.find((e) => e.name === "anthropic");
    expect(entry).toBeDefined();
    const loaded = (await entry?.load()) as
      | { instrumentationName?: string; disable(): void }
      | undefined;
    expect(loaded?.instrumentationName).toBe("@arizeai/openinference-instrumentation-anthropic");

    // Constructing one registers a module hook immediately, and hooks patch in
    // reverse registration order, so leaving this throwaway instance live would
    // let it take the patch away from the instance the next test enables and
    // send that test's spans to the global no-op provider instead.
    loaded?.disable();
  });

  it("is reported as enabled and turns a real Anthropic call into an LLM span", async () => {
    const { exporter, provider } = recordingProvider();
    const enabled = await enableInstrumentations(makeSink(), provider, ["anthropic"]);
    expect(enabled).toContain("anthropic");

    // Loaded through Node's own CJS loader, which is what the package's module
    // hook watches, and only after the entry was enabled: the hook fires on
    // first load, so requiring the SDK earlier would leave it unpatched.
    const { default: Anthropic } = createRequire(import.meta.url)(
      "@anthropic-ai/sdk",
    ) as AnthropicModule;

    // A local stub rather than api.anthropic.com: the assertion is about the
    // span the instrumentation produces, and it needs no real credentials.
    const stub = await stubServer(ANTHROPIC_REPLY);
    try {
      const client = new Anthropic({ apiKey: "not-a-real-key", baseURL: stub.url });
      const reply = await client.messages.create({
        model: "claude-test",
        max_tokens: 16,
        messages: [{ role: "user", content: "what is 2+2" }],
      });
      expect(reply.content[0]?.text).toBe("4");
    } finally {
      stub.close();
    }

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    const attributes = spans[0]?.attributes ?? {};
    expect(attributes["openinference.span.kind"]).toBe("LLM");
    expect(attributes["llm.provider"]).toBe("anthropic");
    expect(attributes["llm.model_name"]).toBe("claude-test");
    expect(attributes["llm.input_messages.0.message.content"]).toBe("what is 2+2");
    expect(attributes["llm.output_messages.0.message.contents.0.message_content.text"]).toBe("4");
    expect(attributes["llm.token_count.prompt"]).toBe(5);
  });
});

describe("the langchain entry", () => {
  it("patches the installed callback manager inside load(), not lazily", async () => {
    const entry = REGISTRY.find((e) => e.name === "langchain");
    expect(entry).toBeDefined();
    const loaded = (await entry?.load()) as { instrumentationName?: string } | undefined;
    expect(loaded?.instrumentationName).toBe("@arizeai/openinference-instrumentation-langchain");

    // The reason the entry resolves the callback manager itself: the package
    // patches nothing until manuallyInstrument() is called, so without that call
    // the entry would report itself enabled over an untouched callback manager.
    const [{ isWrapped }, callbacks] = await Promise.all([
      import("@opentelemetry/instrumentation"),
      import("@langchain/core/callbacks/manager"),
    ]);
    expect(isWrapped(callbacks.CallbackManager._configureSync)).toBe(true);
  });

  // @langchain/core requires Node >= 20: running a chain calls uuidv7, which
  // reads globalThis.crypto — not a global until Node 19. Loading and patching
  // still work on 18, so only the invocation test is gated.
  it.skipIf(nodeMajor < 20)(
    "is reported as enabled and turns a real chain invocation into a CHAIN span",
    async () => {
      const { exporter, provider } = recordingProvider();
      const enabled = await enableInstrumentations(makeSink(), provider, ["langchain"]);
      expect(enabled).toContain("langchain");

      // A plain lambda rather than a model: it goes through the same callback
      // manager every LangChain runnable does, with no provider call.
      const { RunnableLambda } = await import("@langchain/core/runnables");
      const chain = RunnableLambda.from((input: string) => `echo:${input}`).withConfig({
        runName: "RiusEchoChain",
      });
      expect(await chain.invoke("what is 2+2")).toBe("echo:what is 2+2");

      const chainSpan = exporter.getFinishedSpans().find((span) => span.name === "RiusEchoChain");
      expect(chainSpan).toBeDefined();
      const attributes = chainSpan?.attributes ?? {};
      expect(attributes["openinference.span.kind"]).toBe("CHAIN");
      expect(attributes["input.value"]).toBe("what is 2+2");
      expect(attributes["output.value"]).toBe("echo:what is 2+2");
    },
  );
});
