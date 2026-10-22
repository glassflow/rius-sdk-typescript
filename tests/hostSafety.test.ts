/**
 * The SDK never throws into, or breaks, the host app: on bad input it warns
 * and skips. Each case here threw out of an SDK call (or replaced the caller's
 * own error) before it was fixed.
 */
import { type Context, diag } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { init, type RiusClient } from "../src/client.js";
import { DelegatingSpanProcessor } from "../src/delegatingProcessor.js";
import { startGeneration } from "../src/generation.js";
import { instrumentMcpClient } from "../src/instrumentationMcp.js";
import { markCompaction } from "../src/markCompaction.js";
import { observe } from "../src/observe.js";
import { GEN_AI_INPUT_MESSAGES, GEN_AI_OUTPUT_MESSAGES, WORKSPACE_ROUTE } from "../src/semconv.js";
import { startAsCurrentSpan, startSpan } from "../src/spans.js";
import { registerWorkspace, withWorkspace } from "../src/workspace.js";
import { prependProcessor } from "./prependProcessor.js";

let client: RiusClient | undefined;
let exporter: InMemorySpanExporter;

function testInit(options: Parameters<typeof init>[0] = {}): RiusClient {
  exporter = new InMemorySpanExporter();
  client = init({
    spanExporter: exporter,
    serviceName: "host-safety",
    heartbeat: false,
    ...options,
  });
  return client;
}

async function finished(): Promise<ReadableSpan[]> {
  await client?.flush();
  return exporter.getFinishedSpans();
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await client?.shutdown();
  client = undefined;
});

/** A value that throws as soon as anything looks inside it. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

describe("Observation.recordException", () => {
  it("records an error that cannot be turned into a string instead of throwing", async () => {
    testInit();
    const span = startSpan("work");
    const unstringable = Object.create(null);
    expect(() => span.recordException(unstringable)).not.toThrow();
    span.end();
    const [recorded] = await finished();
    expect(recorded.status.code).toBe(2);
  });

  it("lets the caller's own error through a scoped span unchanged", async () => {
    testInit();
    const unstringable = Object.create(null);
    await expect(
      startAsCurrentSpan("work", () => {
        throw unstringable;
      }),
    ).rejects.toBe(unstringable);
  });
});

describe("Generation content setters", () => {
  const hostile: Array<[string, () => unknown]> = [
    [
      "a throwing getter",
      () => [
        {
          role: "user",
          get content() {
            throw new Error("boom");
          },
        },
      ],
    ],
    ["a revoked proxy", revokedProxy],
  ];

  for (const [label, make] of hostile) {
    it(`setInput warns and skips ${label}`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      testInit();
      const generation = startGeneration("llm");
      expect(() => generation.setInput(make())).not.toThrow();
      generation.end();
      const [span] = await finished();
      expect(span.attributes[GEN_AI_INPUT_MESSAGES]).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    });

    it(`setOutput warns and skips ${label}`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      testInit();
      const generation = startGeneration("llm");
      expect(() => generation.setOutput(make())).not.toThrow();
      generation.end();
      const [span] = await finished();
      expect(span.attributes[GEN_AI_OUTPUT_MESSAGES]).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    });
  }

  it("warns once per process, not on every skipped write", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    testInit();
    for (let i = 0; i < 3; i++) {
      const generation = startGeneration("llm");
      generation.setInput(revokedProxy());
      generation.end();
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("still records good content after a skipped write", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    testInit();
    const generation = startGeneration("llm");
    generation.setInput(revokedProxy());
    generation.setInput("hello");
    generation.end();
    const [span] = await finished();
    expect(String(span.attributes[GEN_AI_INPUT_MESSAGES])).toContain("hello");
  });
});

describe("registerWorkspace", () => {
  it("is a silent no-op when the SDK is disabled", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("RIUS_DISABLED", "true");
    testInit({ workspaces: {} });
    expect(() => registerWorkspace("acme", "key-acme")).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once and skips when routing was not enabled", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    testInit();
    expect(() => registerWorkspace("acme", "key-acme")).not.toThrow();
    expect(() => registerWorkspace("globex", "key-globex")).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("workspaces");
  });

  it("warns and skips an empty alias or key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const perKey: Record<string, InMemorySpanExporter> = {};
    testInit({
      workspaces: {},
      workspaceExporterFactory: (apiKey) => {
        perKey[apiKey] = new InMemorySpanExporter();
        return perKey[apiKey];
      },
    });
    expect(() => registerWorkspace("", "key")).not.toThrow();
    expect(() => registerWorkspace("acme", "")).not.toThrow();
    expect(() => registerWorkspace(undefined as never, undefined as never)).not.toThrow();
    // The same bad input warns once per process, not once per call.
    expect(warn).toHaveBeenCalledTimes(1);
    // "acme" was never registered, so its spans fall to the default destination.
    await withWorkspace("acme", async () => startSpan("s").end());
    await finished();
    expect(perKey[""]).toBeUndefined();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["s"]);
  });
});

describe("withWorkspace", () => {
  it("warns and runs the callback unscoped for an empty alias", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    testInit({ workspaces: {} });
    const result = withWorkspace("", (alias) => {
      startSpan("unscoped").end();
      return `ran:${alias}`;
    });
    expect(result).toBe("ran:");
    expect(warn).toHaveBeenCalled();
    const [span] = await finished();
    expect(span.name).toBe("unscoped");
    expect(span.attributes[WORKSPACE_ROUTE]).toBeUndefined();
  });

  it("warns once per process for repeated empty aliases", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    testInit({ workspaces: {} });
    for (let i = 0; i < 3; i++) withWorkspace("", () => undefined);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("clears an enclosing scope for an empty alias, so its spans go to the default destination", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const perKey: Record<string, InMemorySpanExporter> = {};
    testInit({
      workspaces: { acme: "key-acme" },
      workspaceExporterFactory: (apiKey) => {
        perKey[apiKey] ??= new InMemorySpanExporter();
        return perKey[apiKey];
      },
    });
    withWorkspace("acme", () => {
      withWorkspace("", () => startSpan("inner").end());
      startSpan("outer").end();
    });
    await finished();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["inner"]);
    expect(perKey["key-acme"].getFinishedSpans().map((s) => s.name)).toEqual(["outer"]);
  });
});

describe("observe", () => {
  it("calls the wrapped function with the receiver it was called on", async () => {
    testInit();
    const agent = {
      name: "planner",
      run: observe(async function (this: { name: string }) {
        return this.name;
      }),
    };
    await expect(agent.run()).resolves.toBe("planner");
  });
});

class Throwing implements SpanProcessor {
  onStart(_span: Span, _parentContext: Context): void {
    throw new Error("onStart boom");
  }
  onEnd(_span: ReadableSpan): void {
    throw new Error("onEnd boom");
  }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

class Recording implements SpanProcessor {
  readonly started: string[] = [];
  readonly ended: string[] = [];
  onStart(span: Span): void {
    this.started.push((span as unknown as ReadableSpan).name);
  }
  onEnd(span: ReadableSpan): void {
    this.ended.push(span.name);
  }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

describe("DelegatingSpanProcessor", () => {
  it("isolates a throwing delegate: later delegates still run and nothing escapes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const processors = new DelegatingSpanProcessor();
    const after = new Recording();
    processors.add(new Throwing());
    processors.add(after);
    const span = { name: "s" } as unknown as Span;
    expect(() => processors.onStart(span, {} as Context)).not.toThrow();
    expect(() => processors.onEnd(span as unknown as ReadableSpan)).not.toThrow();
    expect(after.started).toEqual(["s"]);
    expect(after.ended).toEqual(["s"]);
    // Throwing threw in both onStart and onEnd: one warning for the delegate.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("logs the full error at debug level", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const debug = vi.spyOn(diag, "debug").mockImplementation(() => {});
    const processors = new DelegatingSpanProcessor();
    processors.add(new Throwing());
    processors.onStart({ name: "s" } as unknown as Span, {} as Context);
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining("Throwing"),
      expect.objectContaining({ message: "onStart boom" }),
    );
  });

  for (const hook of ["forceFlush", "shutdown"] as const) {
    it(`keeps ${hook}() from rejecting when a delegate throws synchronously, and still runs the others`, async () => {
      const processors = new DelegatingSpanProcessor();
      const calls: string[] = [];
      const syncThrow = new Recording();
      syncThrow[hook] = () => {
        throw new Error(`${hook} boom`);
      };
      const after = new Recording();
      after[hook] = async () => {
        calls.push("after");
      };
      processors.add(syncThrow);
      processors.add(after);
      await expect(processors[hook]()).resolves.toBeUndefined();
      expect(calls).toEqual(["after"]);
    });
  }

  it("keeps span.end() from throwing into the caller and still exports the span", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    testInit();
    prependProcessor(client as RiusClient, new Throwing());
    const span = startSpan("exported");
    expect(() => span.end()).not.toThrow();
    expect((await finished()).map((s) => s.name)).toEqual(["exported"]);
  });
});

describe("MCP callTool", () => {
  class FakeMcpClient {
    async callTool(params: { name: string; arguments?: unknown }): Promise<unknown> {
      return { content: [{ type: "text", text: params.name }] };
    }
  }

  it("returns a rejected promise for missing params, as the MCP SDK does, instead of throwing", async () => {
    testInit();
    const uninstall = instrumentMcpClient(FakeMcpClient);
    try {
      let result: Promise<unknown> | undefined;
      expect(() => {
        result = new FakeMcpClient().callTool(undefined as never);
      }).not.toThrow();
      await expect(result).rejects.toBeInstanceOf(TypeError);
    } finally {
      uninstall();
    }
  });
});

describe("markCompaction", () => {
  it("warns and skips options it cannot read", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    testInit();
    const hostile = {
      get kind(): never {
        throw new Error("boom");
      },
    };
    expect(() => markCompaction(hostile)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns once per process for the same bad option in a loop", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    testInit();
    for (let i = 0; i < 3; i++) markCompaction({ kind: "nope" as never });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
