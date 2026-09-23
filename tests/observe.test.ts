import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { observe } from "../src/observe.js";
import { SpanKind } from "../src/semconv.js";
import { startAsCurrentSpan } from "../src/spans.js";

let exporter: InMemorySpanExporter;
let client: RiusClient;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  // heartbeat defaults ON; a no-op transport keeps these tests off the network.
  client = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
});
afterEach(async () => {
  await client.shutdown();
});

describe("observe", () => {
  it("names the span after the function and captures input and output", async () => {
    // The wrapped function here is a bare arrow passed as a call argument, so
    // it has no inferrable name (fn.name === ""); JS name inference does not
    // reach through call arguments to the `const handle = ...` binding. The
    // implementation falls back to "anonymous" rather than emitting "".
    const handle = observe(async (query: string) => `answer:${query}`);
    expect(await handle("q")).toBe("answer:q");
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.name).toBe("anonymous");
    expect(span.attributes["input.value"]).toBe('{"args":["q"],"kwargs":{}}');
    expect(span.attributes["output.value"]).toBe("answer:q");
  });

  it("honours an explicit name and kind", async () => {
    const run = observe(async () => 1, { name: "run", kind: SpanKind.AGENT });
    await run();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.name).toBe("run");
    expect(span.attributes["openinference.span.kind"]).toBe("AGENT");
  });

  it("omits capture when disabled", async () => {
    const fn = observe(async (s: string) => s, { captureInput: false, captureOutput: false });
    await fn("secret");
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["input.value"]).toBeUndefined();
    expect(span.attributes["output.value"]).toBeUndefined();
  });

  it("works on synchronous functions", async () => {
    const add = observe((a: number, b: number) => a + b, { name: "add" });
    expect(await add(1, 2)).toBe(3);
  });

  it("propagates rejections and marks the span as an error", async () => {
    const bad = observe(
      async () => {
        throw new Error("nope");
      },
      { name: "bad" },
    );
    await expect(bad()).rejects.toThrow("nope");
    await client.flush();
    expect(exporter.getFinishedSpans()[0].status.code).toBe(2);
  });

  it("captures the wrapped function's arguments as the serialised span input", async () => {
    const fn = observe(async (a: string, b: number) => `${a}${b}`, { name: "fn" });
    await fn("x", 1);
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["input.value"]).toBe('{"args":["x",1],"kwargs":{}}');
  });

  it("nests under an active span so it participates in context propagation", async () => {
    const inner = observe(async () => "done", { name: "inner" });
    let outerSpanId: string | undefined;
    await startAsCurrentSpan("outer", {}, async (observation) => {
      outerSpanId = observation.span.spanContext().spanId;
      await inner();
    });
    await client.flush();
    const spans = exporter.getFinishedSpans();
    const innerSpan = spans.find((s) => s.name === "inner");
    expect(innerSpan?.parentSpanContext?.spanId).toBe(outerSpanId);
  });

  it("sets the returned function's .name to the resolved span name", () => {
    const wrapped = observe(async () => 1, { name: "resolved-name" });
    expect(wrapped.name).toBe("resolved-name");
  });
});

// GenAI semconv: error.type is Conditionally Required on every span that ends
// in an error; the error's name only (low cardinality), never the message.
describe("observe error.type", () => {
  it("is set when the wrapped function rejects", async () => {
    class ToolBroke extends Error {
      constructor(message: string) {
        super(message);
        this.name = "ToolBroke";
      }
    }
    const bad = observe(
      async () => {
        throw new ToolBroke("details that must not leak");
      },
      { name: "bad-typed" },
    );
    await expect(bad()).rejects.toThrow("details");
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["error.type"]).toBe("ToolBroke");
  });

  it("is set when a synchronous wrapped function throws", async () => {
    const bad = observe(
      () => {
        throw new RangeError("sync nope");
      },
      { name: "bad-sync" },
    );
    await expect(bad()).rejects.toThrow("sync nope");
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["error.type"]).toBe("RangeError");
  });

  it("is absent on success", async () => {
    const ok = observe(async () => 1, { name: "ok" });
    await ok();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["error.type"]).toBeUndefined();
  });
});

describe("observe with kind TOOL", () => {
  it("carries gen_ai.tool.name equal to the span name when the caller named the span", async () => {
    const named = observe(async () => 1, { name: "search-docs", kind: SpanKind.TOOL });
    await named();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.name).toBe("search-docs");
    expect(span.attributes["gen_ai.tool.name"]).toBe("search-docs");
  });

  it("names the span after the operation and the wrapped function, which is the tool", async () => {
    async function lookup(): Promise<number> {
      return 2;
    }
    const derived = observe(lookup, { kind: SpanKind.TOOL });
    await derived();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.name).toBe("execute_tool lookup");
    // The bare function name, never the rendered span name: the attribute is
    // a metric dimension, and `execute_tool lookup` would be a different tool.
    expect(span.attributes["gen_ai.tool.name"]).toBe("lookup");
  });

  it("derives the tool name from the function without the span-name warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      async function fetchPrice(): Promise<number> {
        return 3;
      }
      await observe(fetchPrice, { kind: SpanKind.TOOL })();
      await client.flush();
      // Nothing is being reused as something else here, so there is nothing
      // to deprecate: the warning is about span names doubling as tool names.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("takes an explicit tool name that differs from the span name", async () => {
    const wrapped = observe(async () => 1, {
      name: "execute_tool search-docs",
      kind: SpanKind.TOOL,
      toolName: "search-docs",
    });
    await wrapped();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.name).toBe("execute_tool search-docs");
    expect(span.attributes["gen_ai.tool.name"]).toBe("search-docs");
  });
});

// The conventions name a span `{operation} {target}`. `observe` has no span
// name of its own to fall back to for those kinds — the function's name is
// not a model, an agent or an index — so the composed name is the default,
// and CHAIN, which has no operation, keeps the function name.
describe("observe span names", () => {
  it("keeps the function name on a CHAIN, the one kind with no operation", async () => {
    async function planTrip(): Promise<number> {
      return 1;
    }
    await observe(planTrip)();
    await observe(planTrip, { kind: SpanKind.CHAIN })();
    await client.flush();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["planTrip", "planTrip"]);
  });

  it("composes an AGENT name from the invoked agent", async () => {
    async function delegate(): Promise<number> {
      return 1;
    }
    await observe(delegate, { kind: SpanKind.AGENT, agentName: "planner" })();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].name).toBe("invoke_agent planner");
  });

  it("composes a RETRIEVER name from the data source", async () => {
    async function search(): Promise<string[]> {
      return ["doc"];
    }
    await observe(search, { kind: SpanKind.RETRIEVER, dataSourceId: "docs-index" })();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].name).toBe("retrieval docs-index");
  });

  it("falls back to the bare operation when the target is unknown", async () => {
    async function anon(): Promise<number> {
      return 1;
    }
    await observe(anon, { kind: SpanKind.RETRIEVER })();
    await observe(anon, { kind: SpanKind.EMBEDDING })();
    await observe(anon, { kind: SpanKind.LLM })();
    await client.flush();
    // No AGENT here: an initialised client always knows an agent name, so
    // that fallback is a semconv unit test rather than a wrapper one.
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual([
      "retrieval",
      "embeddings",
      "chat",
    ]);
  });

  it("lets an explicit name win on every kind", async () => {
    async function work(): Promise<number> {
      return 1;
    }
    for (const kind of [SpanKind.TOOL, SpanKind.AGENT, SpanKind.RETRIEVER, SpanKind.CHAIN]) {
      await observe(work, { kind, name: `mine-${kind}` })();
    }
    await client.flush();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual([
      "mine-TOOL",
      "mine-AGENT",
      "mine-RETRIEVER",
      "mine-CHAIN",
    ]);
  });

  it("names the wrapper after the function, not after the composed span", async () => {
    async function lookup(): Promise<number> {
      return 1;
    }
    expect(observe(lookup, { kind: SpanKind.TOOL }).name).toBe("lookup");
  });
});

describe("observe with kind RETRIEVER", () => {
  it("carries the retrieval operation and an explicit data source", async () => {
    const search = observe(async () => ["doc"], {
      name: "search",
      kind: SpanKind.RETRIEVER,
      dataSourceId: "docs-index",
    });
    await search();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.operation.name"]).toBe("retrieval");
    expect(span.attributes["gen_ai.data_source.id"]).toBe("docs-index");
  });
});
