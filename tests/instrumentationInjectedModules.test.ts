import http from "node:http";
import * as anthropicSdk from "@anthropic-ai/sdk";
import { AnthropicInstrumentation } from "@arizeai/openinference-instrumentation-anthropic";
import * as anthropicInstrumentation from "@arizeai/openinference-instrumentation-anthropic";
import { OpenAIInstrumentation } from "@arizeai/openinference-instrumentation-openai";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { enableInstrumentations } from "../src/instrumentation.js";

// Modules the app imported itself, handed to init() instead of being resolved
// by the SDK. Each test builds fresh doubles so none sees another's recordings,
// and nothing here lets the SDK resolve an optional peer on the injected path.

// init() hands back the existing client while one is active, so a client that
// is never shut down silently becomes every later test's client.
let live: RiusClient | undefined;

/** init(), remembered so the teardown can release it if the test does not. */
function initTracked(options: Parameters<typeof init>[0] = {}): RiusClient {
  live = init(options);
  return live;
}

afterEach(async () => {
  const client = live;
  live = undefined;
  await client?.shutdown().catch(() => {});
});

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

/** Silences and records console.warn. Callers must mockRestore in a finally. */
function spyOnWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
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

const ANTHROPIC_REPLY = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-test",
  content: [{ type: "text", text: "4" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 5, output_tokens: 1 },
};

/**
 * An anthropic instrumentation that only records what it is asked to patch,
 * with a fake SDK of the shape `anthropicPatchable` accepts.
 */
function anthropicDoubles() {
  const patched: object[] = [];
  class Recording extends AnthropicInstrumentation {
    manuallyInstrument(module: object): void {
      patched.push(module);
    }
  }
  const FakeAnthropic = Object.assign(function FakeAnthropic() {}, {
    Messages: class {
      create() {}
    },
  });
  return {
    patched,
    FakeAnthropic,
    modules: {
      instrumentation: { AnthropicInstrumentation: Recording },
      sdk: { default: FakeAnthropic },
    },
  };
}

/** The openai counterpart, with the `Chat.Completions.prototype.create` shape. */
function openaiDoubles() {
  const patched: object[] = [];
  class Recording extends OpenAIInstrumentation {
    manuallyInstrument(module: object): void {
      patched.push(module);
    }
  }
  const FakeOpenAI = Object.assign(function FakeOpenAI() {}, {
    Chat: {
      Completions: class {
        create() {}
      },
    },
  });
  return {
    patched,
    FakeOpenAI,
    modules: {
      instrumentation: { OpenAIInstrumentation: Recording },
      sdk: { OpenAI: FakeOpenAI },
    },
  };
}

/** Runs `body` with a fresh teardown array and always runs what it collected. */
async function withTeardown(body: (teardown: Array<() => void>) => Promise<void>): Promise<void> {
  const teardown: Array<() => void> = [];
  try {
    await body(teardown);
  } finally {
    for (const undo of teardown) undo();
  }
}

describe("instrumentModules through enableInstrumentations", () => {
  it("enables anthropic from the injected modules and patches the injected SDK", async () => {
    const { patched, FakeAnthropic, modules } = anthropicDoubles();
    const { provider } = recordingProvider();
    await withTeardown(async (teardown) => {
      const enabled = await enableInstrumentations(makeSink(), provider, ["anthropic"], teardown, {
        instrumentModules: { anthropic: modules },
      });
      expect(enabled).toEqual(["anthropic"]);
    });
    expect(patched).toHaveLength(1);
    expect((patched[0] as { default: unknown }).default).toBe(FakeAnthropic);
  });

  it("enables openai from the injected modules and patches the injected SDK", async () => {
    const { patched, FakeOpenAI, modules } = openaiDoubles();
    const { provider } = recordingProvider();
    await withTeardown(async (teardown) => {
      const enabled = await enableInstrumentations(makeSink(), provider, ["openai"], teardown, {
        instrumentModules: { openai: modules },
      });
      expect(enabled).toEqual(["openai"]);
    });
    expect(patched).toHaveLength(1);
    expect((patched[0] as { OpenAI: unknown }).OpenAI).toBe(FakeOpenAI);
  });

  it("warns once and leaves anthropic out when the injected SDK has the wrong shape", async () => {
    const { patched, modules } = anthropicDoubles();
    const { provider } = recordingProvider();
    const warn = spyOnWarn();
    try {
      await withTeardown(async (teardown) => {
        const enabled = await enableInstrumentations(
          makeSink(),
          provider,
          ["anthropic"],
          teardown,
          {
            instrumentModules: { anthropic: { ...modules, sdk: {} } },
          },
        );
        expect(enabled).toEqual([]);
      });
      expect(patched).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("anthropic");
    } finally {
      warn.mockRestore();
    }
  });

  it("warns once and leaves anthropic out when the injected instrumentation lacks its export", async () => {
    const { modules } = anthropicDoubles();
    const { provider } = recordingProvider();
    const warn = spyOnWarn();
    try {
      await withTeardown(async (teardown) => {
        const enabled = await enableInstrumentations(
          makeSink(),
          provider,
          ["anthropic"],
          teardown,
          {
            instrumentModules: { anthropic: { ...modules, instrumentation: {} } },
          },
        );
        expect(enabled).toEqual([]);
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("anthropic");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("instrumentModules through init()", () => {
  it("reports the injected integration in client.ready and patches the injected SDK", async () => {
    const { patched, FakeAnthropic, modules } = anthropicDoubles();
    const client = initTracked({
      spanExporter: new InMemorySpanExporter(),
      heartbeatTransport: async () => {},
      instrumentModules: { anthropic: modules },
    });
    expect(await client.ready).toContain("anthropic");
    expect(patched).toHaveLength(1);
    expect((patched[0] as { default: unknown }).default).toBe(FakeAnthropic);
  });
});

describe("real modules through instrumentModules", () => {
  it("turns a real client call into an LLM span", async () => {
    const { exporter, provider } = recordingProvider();
    await withTeardown(async (teardown) => {
      const enabled = await enableInstrumentations(makeSink(), provider, ["anthropic"], teardown, {
        instrumentModules: {
          anthropic: { instrumentation: anthropicInstrumentation, sdk: anthropicSdk },
        },
      });
      expect(enabled).toEqual(["anthropic"]);

      const Anthropic = anthropicSdk.default;
      const stub = await stubServer(ANTHROPIC_REPLY);
      try {
        const client = new Anthropic({ apiKey: "not-a-real-key", baseURL: stub.url });
        await client.messages.create({
          model: "claude-test",
          max_tokens: 16,
          messages: [{ role: "user", content: "what is 2+2" }],
        });
      } finally {
        stub.close();
      }
    });

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    const attributes = spans[0]?.attributes ?? {};
    expect(attributes["openinference.span.kind"]).toBe("LLM");
    expect(attributes["llm.model_name"]).toBe("claude-test");
  });
});
