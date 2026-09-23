import { SpanKind as OtelSpanKind } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { observe } from "../src/observe.js";
import { SpanKind } from "../src/semconv.js";
import { startAsCurrentSpan, startSpan } from "../src/spans.js";

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

describe("startSpan", () => {
  it("sets kind attributes at creation and records input and output", async () => {
    const obs = startSpan("retrieve", { kind: SpanKind.RETRIEVER, input: { q: "x" } });
    obs.setOutput(["doc"]);
    obs.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["openinference.span.kind"]).toBe("RETRIEVER");
    expect(span.attributes["input.value"]).toBe('{"q":"x"}');
    expect(span.attributes["output.value"]).toBe('["doc"]');
  });

  it("does not become the active parent, since it was never called current", async () => {
    const outer = startSpan("outer");
    startSpan("inner").end();
    outer.end();
    await client.flush();
    const inner = exporter.getFinishedSpans().find((s) => s.name === "inner");
    expect(inner?.parentSpanContext).toBeUndefined();
  });

  it("records an exception and ERROR status on the manual path", async () => {
    const obs = startSpan("manual");
    obs.recordException(new Error("nope"));
    obs.end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span.status.message).toBe("nope");
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("wraps a non-Error throwable so recordException still gets an Error", async () => {
    const obs = startSpan("manual-nonerror");
    obs.recordException("just a string");
    obs.end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].status.message).toBe("just a string");
  });

  it("ends at scope exit via Symbol.dispose", async () => {
    {
      using _obs = startSpan("disposed");
    }
    await client.flush();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toContain("disposed");
  });
});

describe("startAsCurrentSpan", () => {
  it("nests children across async boundaries and auto-ends", async () => {
    await startAsCurrentSpan("parent", { kind: SpanKind.AGENT }, async () => {
      await Promise.resolve();
      await startAsCurrentSpan("child", {}, async () => {});
    });
    await client.flush();
    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === "parent");
    const child = spans.find((s) => s.name === "child");
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
  });

  it("returns the callback result", async () => {
    expect(await startAsCurrentSpan("s", {}, async () => 42)).toBe(42);
  });

  it("accepts the callback directly, with no options argument", async () => {
    expect(await startAsCurrentSpan("no-options", async () => 7)).toBe(7);
    await client.flush();
    const span = exporter.getFinishedSpans().find((s) => s.name === "no-options");
    expect(span?.attributes["openinference.span.kind"]).toBe("CHAIN");
  });

  it("still records exceptions in the options-free form", async () => {
    await expect(
      startAsCurrentSpan("no-options-boom", async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    await client.flush();
    expect(exporter.getFinishedSpans().find((s) => s.name === "no-options-boom")?.status.code).toBe(
      2,
    );
  });

  it("records the exception, sets ERROR status, ends the span and rethrows", async () => {
    await expect(
      startAsCurrentSpan("boom", {}, async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    await client.flush();
    const span = exporter.getFinishedSpans().find((s) => s.name === "boom");
    expect(span?.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span?.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("ends the span even when the callback throws, keeping the finished span with ERROR status", async () => {
    let caught: unknown;
    try {
      await startAsCurrentSpan("leak-check", {}, async () => {
        throw new Error("boom-leak");
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    await client.flush();
    const span = exporter.getFinishedSpans().find((s) => s.name === "leak-check");
    expect(span).toBeDefined();
    expect(span?.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span?.ended).toBe(true);
  });
});

describe("Observation.setAttribute value handling", () => {
  it("passes primitive arrays through as OTel arrays and skips undefined/null", async () => {
    const obs = startSpan("attrs");
    obs.setAttribute("tags", ["a", "b"]);
    obs.setAttribute("nums", [1, 2]);
    obs.setAttribute("nothing", undefined);
    obs.setAttribute("nil", null);
    obs.setAttribute("obj", { k: "v" });
    obs.end();
    await client.flush();
    const attrs = exporter.getFinishedSpans()[0].attributes;
    expect(attrs.tags).toEqual(["a", "b"]);
    expect(attrs.nums).toEqual([1, 2]);
    expect("nothing" in attrs).toBe(false);
    expect("nil" in attrs).toBe(false);
    expect(attrs.obj).toBe('{"k":"v"}');
  });
});

// GenAI semconv: error.type is Conditionally Required on every span that ends
// in an error; the error's name only (low cardinality), never the message.
describe("error.type", () => {
  it("is set by Observation.recordException on the manual path", async () => {
    const obs = startSpan("manual-error-type");
    obs.recordException(new Error("nope"));
    obs.end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["error.type"]).toBe("Error");
  });

  it("uses the subclass name and never the message", async () => {
    class ToolBroke extends Error {
      constructor(message: string) {
        super(message);
        this.name = "ToolBroke";
      }
    }
    const obs = startSpan("manual-subclass");
    obs.recordException(new ToolBroke("details that must not leak"));
    obs.end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["error.type"]).toBe("ToolBroke");
  });

  it("labels a non-Error throwable by its runtime type", async () => {
    const obs = startSpan("manual-nonerror-type");
    obs.recordException("just a string");
    obs.end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["error.type"]).toBe("string");
  });

  it("is set on the scoped path when the callback throws", async () => {
    await expect(
      startAsCurrentSpan("scoped-error-type", {}, async () => {
        throw new RangeError("nope");
      }),
    ).rejects.toThrow("nope");
    await client.flush();
    const span = exporter.getFinishedSpans().find((s) => s.name === "scoped-error-type");
    expect(span?.attributes["error.type"]).toBe("RangeError");
    expect(span?.status.code).toBe(2);
    expect(span?.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("is absent on success", async () => {
    await startAsCurrentSpan("fine", {}, async () => 1);
    startSpan("also-fine").end();
    await client.flush();
    for (const span of exporter.getFinishedSpans()) {
      expect(span.attributes["error.type"]).toBeUndefined();
    }
  });
});

describe("gen_ai.tool.name on local tool spans", () => {
  // The GenAI execute-tool convention requires gen_ai.tool.name; for a local
  // tool the span name is the tool name.
  it("startSpan with kind TOOL carries gen_ai.tool.name equal to the span name", async () => {
    startSpan("weather", { kind: SpanKind.TOOL }).end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.name).toBe("weather");
    expect(span.attributes["gen_ai.tool.name"]).toBe("weather");
  });

  it("startAsCurrentSpan with kind TOOL carries gen_ai.tool.name equal to the span name", async () => {
    await startAsCurrentSpan("weather", { kind: SpanKind.TOOL }, async () => 1);
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.tool.name"]).toBe("weather");
  });

  it("a CHAIN span does not carry gen_ai.tool.name", async () => {
    await startAsCurrentSpan("step", async () => 1);
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["gen_ai.tool.name"]).toBeUndefined();
  });

  it("the exported pending snapshot of a TOOL span carries gen_ai.tool.name", async () => {
    // shutdown() stops the shared exporter, so the partial-spans client gets its own.
    await client.shutdown();
    const pendingExporter = new InMemorySpanExporter();
    client = init({
      spanExporter: pendingExporter,
      partialSpans: true,
      heartbeatTransport: async () => {},
    });
    const obs = startSpan("weather", { kind: SpanKind.TOOL, input: { city: "Berlin" } });
    await client.flush(); // the snapshot is exported while the span is still open
    const pending = pendingExporter
      .getFinishedSpans()
      .filter((s) => s.attributes["rius.span.pending"] === true);
    obs.end();
    expect(pending).toHaveLength(1);
    expect(pending[0].attributes["gen_ai.tool.name"]).toBe("weather");
    expect(pending[0].attributes["gen_ai.operation.name"]).toBe("execute_tool");
    expect(pending[0].attributes["input.value"]).toBeUndefined();
  });

  it("takes an explicit tool name that differs from the span name", async () => {
    startSpan("execute_tool weather", { kind: SpanKind.TOOL, toolName: "weather" }).end();
    await startAsCurrentSpan(
      "execute_tool lookup",
      { kind: SpanKind.TOOL, toolName: "lookup" },
      async () => 1,
    );
    await client.flush();
    const byName = new Map(exporter.getFinishedSpans().map((s) => [s.name, s.attributes]));
    expect(byName.get("execute_tool weather")?.["gen_ai.tool.name"]).toBe("weather");
    expect(byName.get("execute_tool lookup")?.["gen_ai.tool.name"]).toBe("lookup");
  });

  it("ignores an explicit tool name on a kind that is not TOOL", async () => {
    startSpan("step", { kind: SpanKind.CHAIN, toolName: "weather" }).end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["gen_ai.tool.name"]).toBeUndefined();
  });
});

describe("RETRIEVER spans", () => {
  it("carries both taxonomy keys", async () => {
    startSpan("retrieve", { kind: SpanKind.RETRIEVER }).end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["openinference.span.kind"]).toBe("RETRIEVER");
    expect(span.attributes["gen_ai.operation.name"]).toBe("retrieval");
  });

  it("carries gen_ai.retrieval.top_k, which describes the request", async () => {
    startSpan("retrieve", { kind: SpanKind.RETRIEVER, topK: 5 }).end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["gen_ai.retrieval.top_k"]).toBe(5);
  });

  it("ignores topK on a kind that is not RETRIEVER", async () => {
    startSpan("step", { kind: SpanKind.CHAIN, topK: 5 }).end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["gen_ai.retrieval.top_k"]).toBeUndefined();
  });

  it("records what came back separately, once the search has run", async () => {
    const obs = startSpan("retrieve", {
      kind: SpanKind.RETRIEVER,
      dataSourceId: "docs",
      topK: 2,
    });
    obs.setRetrievedDocuments([
      { id: "doc-1", score: 0.91 },
      { id: "doc-2", score: 0.4 },
    ]);
    obs.end();
    await client.flush();
    const attrs = exporter.getFinishedSpans()[0].attributes;
    expect(JSON.parse(attrs["gen_ai.retrieval.documents"] as string)).toEqual([
      { id: "doc-1", score: 0.91 },
      { id: "doc-2", score: 0.4 },
    ]);
    // The request half stays alongside the result half.
    expect(attrs["gen_ai.data_source.id"]).toBe("docs");
    expect(attrs["gen_ai.retrieval.top_k"]).toBe(2);
  });

  it("carries gen_ai.data_source.id when a data source is given", async () => {
    startSpan("retrieve", { kind: SpanKind.RETRIEVER, dataSourceId: "docs-index" }).end();
    await startAsCurrentSpan(
      "retrieve-scoped",
      { kind: SpanKind.RETRIEVER, dataSourceId: "faq-index" },
      async () => 1,
    );
    await client.flush();
    const byName = new Map(exporter.getFinishedSpans().map((s) => [s.name, s.attributes]));
    expect(byName.get("retrieve")?.["gen_ai.data_source.id"]).toBe("docs-index");
    expect(byName.get("retrieve-scoped")?.["gen_ai.data_source.id"]).toBe("faq-index");
  });

  it("omits gen_ai.data_source.id when none is given", async () => {
    startSpan("retrieve", { kind: SpanKind.RETRIEVER }).end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["gen_ai.data_source.id"]).toBeUndefined();
  });

  it("ignores a data source on a kind that is not RETRIEVER", async () => {
    startSpan("step", { kind: SpanKind.CHAIN, dataSourceId: "docs-index" }).end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["gen_ai.data_source.id"]).toBeUndefined();
  });

  it("puts the data source on the pending snapshot, so a running retrieval is attributable", async () => {
    await client.shutdown();
    const pendingExporter = new InMemorySpanExporter();
    client = init({
      spanExporter: pendingExporter,
      partialSpans: true,
      heartbeatTransport: async () => {},
    });
    const obs = startSpan("retrieve", { kind: SpanKind.RETRIEVER, dataSourceId: "docs-index" });
    await client.flush();
    const pending = pendingExporter
      .getFinishedSpans()
      .filter((s) => s.attributes["rius.span.pending"] === true);
    obs.end();
    expect(pending).toHaveLength(1);
    expect(pending[0].attributes["gen_ai.data_source.id"]).toBe("docs-index");
    expect(pending[0].attributes["gen_ai.operation.name"]).toBe("retrieval");
  });
});

describe("the OTel SpanKind field, derived from the taxonomy", () => {
  const cases: [SpanKind, OtelSpanKind][] = [
    [SpanKind.LLM, OtelSpanKind.CLIENT],
    [SpanKind.EMBEDDING, OtelSpanKind.CLIENT],
    [SpanKind.RETRIEVER, OtelSpanKind.CLIENT],
    [SpanKind.TOOL, OtelSpanKind.INTERNAL],
    [SpanKind.AGENT, OtelSpanKind.INTERNAL],
    [SpanKind.CHAIN, OtelSpanKind.INTERNAL],
  ];

  it.each(cases)("maps %s on both the manual and the scoped path", async (kind, expected) => {
    startSpan("manual", { kind }).end();
    await startAsCurrentSpan("scoped", { kind }, () => {});
    await client.flush();
    const kinds = Object.fromEntries(exporter.getFinishedSpans().map((s) => [s.name, s.kind]));
    expect(kinds).toEqual({ manual: expected, scoped: expected });
  });

  it("leaves the default CHAIN span INTERNAL", async () => {
    startSpan("step").end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].kind).toBe(OtelSpanKind.INTERNAL);
  });

  it("lets an explicit otelKind win over the taxonomy mapping", async () => {
    startSpan("remote-tool", { kind: SpanKind.TOOL, otelKind: OtelSpanKind.CLIENT }).end();
    await startAsCurrentSpan(
      "local-llm",
      { kind: SpanKind.LLM, otelKind: OtelSpanKind.INTERNAL },
      () => {},
    );
    await client.flush();
    const kinds = Object.fromEntries(exporter.getFinishedSpans().map((s) => [s.name, s.kind]));
    expect(kinds).toEqual({
      "remote-tool": OtelSpanKind.CLIENT,
      "local-llm": OtelSpanKind.INTERNAL,
    });
  });
});

describe("tool name resolution", () => {
  it("still names the tool from the span name, and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      startSpan("search-docs", { kind: SpanKind.TOOL }).end();
      startSpan("search-docs", { kind: SpanKind.TOOL }).end();
      await client.flush();
      const spans = exporter.getFinishedSpans();
      // The identity is preserved, which is the point: dropping it would
      // rename the tool of every existing caller who passed a span name.
      expect(spans[0].attributes["gen_ai.tool.name"]).toBe("search-docs");
      // Warned, but once, not per span: a tool in a loop must not flood.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("naming the tool as well as the span");
    } finally {
      warn.mockRestore();
    }
  });

  it("stays quiet when the tool name is given explicitly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      startSpan("execute_tool weather", { kind: SpanKind.TOOL, toolName: "weather" }).end();
      await client.flush();
      expect(exporter.getFinishedSpans()[0].attributes["gen_ai.tool.name"]).toBe("weather");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("stays quiet on a kind that is not TOOL", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      startSpan("step-one", { kind: SpanKind.CHAIN }).end();
      await client.flush();
      expect(exporter.getFinishedSpans()[0].attributes["gen_ai.tool.name"]).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("AGENT spans", () => {
  it("takes an explicit agent name and id, on both surfaces", async () => {
    startSpan("plan", { kind: SpanKind.AGENT, agentName: "planner", agentId: "ag_1" }).end();
    await startAsCurrentSpan(
      "research",
      { kind: SpanKind.AGENT, agentName: "researcher" },
      () => 1,
    );
    await client.flush();
    const byName = new Map(exporter.getFinishedSpans().map((s) => [s.name, s.attributes]));
    expect(byName.get("plan")?.["gen_ai.agent.name"]).toBe("planner");
    expect(byName.get("plan")?.["gen_ai.agent.id"]).toBe("ag_1");
    expect(byName.get("research")?.["gen_ai.agent.name"]).toBe("researcher");
    expect(byName.get("research")?.["gen_ai.agent.id"]).toBeUndefined();
  });

  it("ignores an agent name on a kind that is not AGENT", async () => {
    startSpan("step", { kind: SpanKind.CHAIN, agentName: "planner", agentId: "ag_1" }).end();
    await client.flush();
    const attributes = exporter.getFinishedSpans()[0].attributes;
    expect(attributes["gen_ai.agent.name"]).toBeUndefined();
    expect(attributes["gen_ai.agent.id"]).toBeUndefined();
  });
});

describe("the configured agent name", () => {
  let scoped: RiusClient;
  let scopedExporter: InMemorySpanExporter;

  beforeEach(async () => {
    await client.shutdown();
    scopedExporter = new InMemorySpanExporter();
    scoped = init({
      spanExporter: scopedExporter,
      agentName: "configured",
      heartbeatTransport: async () => {},
    });
  });
  afterEach(async () => {
    await scoped.shutdown();
    // the outer afterEach shuts down an already-shut-down client, which is a no-op
  });

  it("names an unnamed AGENT span, because a single-agent process knows the answer", async () => {
    startSpan("plan", { kind: SpanKind.AGENT }).end();
    await scoped.flush();
    expect(scopedExporter.getFinishedSpans()[0].attributes["gen_ai.agent.name"]).toBe("configured");
  });

  it("loses to an explicit name, the case a multi-agent process turns on", async () => {
    startSpan("plan", { kind: SpanKind.AGENT, agentName: "researcher" }).end();
    await scoped.flush();
    expect(scopedExporter.getFinishedSpans()[0].attributes["gen_ai.agent.name"]).toBe("researcher");
  });

  it("does not reach a span of any other kind", async () => {
    startSpan("step", { kind: SpanKind.CHAIN }).end();
    await scoped.flush();
    expect(scopedExporter.getFinishedSpans()[0].attributes["gen_ai.agent.name"]).toBeUndefined();
  });
});

// The GenAI conventions name a span `{operation} {target}` — `chat gpt-4o`,
// `execute_tool get_weather` — falling back to the bare operation when the
// target is unknown. Omitting the name is how a caller asks for that.
describe("spec-form span names", () => {
  it("composes the name from the operation and the target, on both surfaces", async () => {
    startSpan({ kind: SpanKind.TOOL, toolName: "get_weather" }).end();
    startSpan({ kind: SpanKind.AGENT, agentName: "planner" }).end();
    startSpan({ kind: SpanKind.RETRIEVER, dataSourceId: "docs-index" }).end();
    startSpan({
      kind: SpanKind.EMBEDDING,
      attributes: { "gen_ai.request.model": "text-embedding-3-small" },
    }).end();
    await startAsCurrentSpan({ kind: SpanKind.TOOL, toolName: "get_weather" }, () => {});
    await startAsCurrentSpan({ kind: SpanKind.AGENT, agentName: "planner" }, () => {});
    await startAsCurrentSpan({ kind: SpanKind.RETRIEVER, dataSourceId: "docs-index" }, () => {});
    await startAsCurrentSpan(
      {
        kind: SpanKind.EMBEDDING,
        attributes: { "gen_ai.request.model": "text-embedding-3-small" },
      },
      () => {},
    );
    await client.flush();
    const expected = [
      "execute_tool get_weather",
      "invoke_agent planner",
      "retrieval docs-index",
      "embeddings text-embedding-3-small",
    ];
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual([...expected, ...expected]);
  });

  it("falls back to the bare operation when the target is unknown", async () => {
    startSpan({ kind: SpanKind.TOOL }).end();
    startSpan({ kind: SpanKind.RETRIEVER }).end();
    startSpan({ kind: SpanKind.EMBEDDING }).end();
    startSpan({ kind: SpanKind.LLM }).end();
    await client.flush();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual([
      "execute_tool",
      "retrieval",
      "embeddings",
      "chat",
    ]);
    // AGENT is absent on purpose: an initialised client always has an agent
    // name (it defaults to the service name), so an AGENT span always has a
    // target here. The nameless case is covered in the semconv unit tests.
  });

  it("leaves an unnamed TOOL span's tool attribute unset rather than guessing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      startSpan({ kind: SpanKind.TOOL }).end();
      await client.flush();
      expect(exporter.getFinishedSpans()[0].attributes["gen_ai.tool.name"]).toBeUndefined();
      // No name is being reused as a tool name, so nothing to deprecate.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("never feeds the rendered name back into the tool attribute", async () => {
    startSpan({ kind: SpanKind.TOOL, toolName: "get_weather" }).end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.name).toBe("execute_tool get_weather");
    expect(span.attributes["gen_ai.tool.name"]).toBe("get_weather");
  });

  it("uses the literal chain for an unnamed CHAIN, which has nothing to compose from", async () => {
    startSpan().end();
    startSpan({ kind: SpanKind.CHAIN, input: { q: "x" } }).end();
    await startAsCurrentSpan(() => {});
    await client.flush();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["chain", "chain", "chain"]);
  });

  it("lets an explicit name win on every kind, on both surfaces", async () => {
    const kinds = [
      SpanKind.LLM,
      SpanKind.EMBEDDING,
      SpanKind.TOOL,
      SpanKind.AGENT,
      SpanKind.RETRIEVER,
      SpanKind.CHAIN,
    ];
    for (const kind of kinds) {
      startSpan(`manual-${kind}`, { kind, toolName: "t", agentName: "a", dataSourceId: "d" }).end();
      await startAsCurrentSpan(
        `scoped-${kind}`,
        { kind, toolName: "t", agentName: "a", dataSourceId: "d" },
        () => {},
      );
    }
    await client.flush();
    const names = new Set(exporter.getFinishedSpans().map((s) => s.name));
    for (const kind of kinds) {
      expect(names.has(`manual-${kind}`)).toBe(true);
      expect(names.has(`scoped-${kind}`)).toBe(true);
    }
  });

  it("gives a pending snapshot the same name as the final span", async () => {
    await client.shutdown();
    const pendingExporter = new InMemorySpanExporter();
    client = init({
      spanExporter: pendingExporter,
      partialSpans: true,
      heartbeatTransport: async () => {},
    });
    const obs = startSpan({ kind: SpanKind.TOOL, toolName: "get_weather" });
    await client.flush();
    const pending = pendingExporter
      .getFinishedSpans()
      .filter((s) => s.attributes["rius.span.pending"] === true);
    obs.end();
    await client.flush();
    const final = pendingExporter
      .getFinishedSpans()
      .filter((s) => s.attributes["rius.span.pending"] === undefined);
    expect(pending).toHaveLength(1);
    expect(final).toHaveLength(1);
    // The wire contract: the snapshot is replaced by the final span, so the
    // two must agree on the name as well as on the ids.
    expect(pending[0].name).toBe("execute_tool get_weather");
    expect(final[0].name).toBe(pending[0].name);
  });
});

describe("spec-form names and the configured agent name", () => {
  let scoped: RiusClient;
  let scopedExporter: InMemorySpanExporter;

  beforeEach(async () => {
    await client.shutdown();
    scopedExporter = new InMemorySpanExporter();
    scoped = init({
      spanExporter: scopedExporter,
      agentName: "configured",
      heartbeatTransport: async () => {},
    });
  });
  afterEach(async () => {
    await scoped.shutdown();
  });

  it("names an unnamed AGENT span after the agent init() was given", async () => {
    startSpan({ kind: SpanKind.AGENT }).end();
    await scoped.flush();
    const span = scopedExporter.getFinishedSpans()[0];
    expect(span.name).toBe("invoke_agent configured");
    expect(span.attributes["gen_ai.agent.name"]).toBe("configured");
  });
});

describe("the unknown_service placeholder", () => {
  it("is not an agent name: a process that named nothing has none", async () => {
    // Both the service name and the agent name resolve to the same
    // placeholder when nothing was configured, so emitting it would claim an
    // identity the caller never supplied.
    await client.shutdown();
    const exp = new InMemorySpanExporter();
    const bare = init({ spanExporter: exp, heartbeatTransport: async () => {} });
    try {
      startSpan("plan", { kind: SpanKind.AGENT }).end();
      await bare.flush();
      expect(exp.getFinishedSpans()[0].attributes["gen_ai.agent.name"]).toBeUndefined();
    } finally {
      await bare.shutdown();
    }
  });

  it("does not suppress a real name in a process with no service name", async () => {
    await client.shutdown();
    const exp = new InMemorySpanExporter();
    const bare = init({ spanExporter: exp, heartbeatTransport: async () => {} });
    try {
      startSpan("plan", { kind: SpanKind.AGENT, agentName: "researcher" }).end();
      await bare.flush();
      expect(exp.getFinishedSpans()[0].attributes["gen_ai.agent.name"]).toBe("researcher");
    } finally {
      await bare.shutdown();
    }
  });
});

/**
 * `gen_ai.agent.name` says two different things, told apart by
 * `gen_ai.operation.name`: on an `invoke_agent` span it is the agent BEING
 * INVOKED, on an `execute_tool` span the agent EXECUTING the tool. These
 * tests pin the second reading, and the last one pins both at once so a
 * future refactor cannot quietly merge them.
 */
describe("the agent executing a tool", () => {
  it("names the enclosing agent on a TOOL span, on the scoped surface", async () => {
    await startAsCurrentSpan({ kind: SpanKind.AGENT, agentName: "planner" }, async () => {
      await startAsCurrentSpan({ kind: SpanKind.TOOL, toolName: "get_weather" }, () => {});
    });
    await client.flush();
    const tool = exporter.getFinishedSpans().find((s) => s.name === "execute_tool get_weather");
    expect(tool?.attributes["gen_ai.agent.name"]).toBe("planner");
  });

  it("names it through observe, which is built on the same scope", async () => {
    const getWeather = observe(async () => "sunny", {
      kind: SpanKind.TOOL,
      toolName: "get_weather",
    });
    const plan = observe(async () => await getWeather(), {
      kind: SpanKind.AGENT,
      agentName: "planner",
    });
    await plan();
    await client.flush();
    const tool = exporter.getFinishedSpans().find((s) => s.name === "execute_tool get_weather");
    expect(tool?.attributes["gen_ai.agent.name"]).toBe("planner");
  });

  it("lets the innermost agent win, since that is the one making the call", async () => {
    await startAsCurrentSpan({ kind: SpanKind.AGENT, agentName: "orchestrator" }, async () => {
      await startAsCurrentSpan({ kind: SpanKind.AGENT, agentName: "researcher" }, async () => {
        await startAsCurrentSpan({ kind: SpanKind.TOOL, toolName: "search" }, () => {});
      });
      await startAsCurrentSpan({ kind: SpanKind.TOOL, toolName: "report" }, () => {});
    });
    await client.flush();
    const byName = new Map(exporter.getFinishedSpans().map((s) => [s.name, s.attributes]));
    expect(byName.get("execute_tool search")?.["gen_ai.agent.name"]).toBe("researcher");
    // And the outer scope is intact once the inner one unwinds.
    expect(byName.get("execute_tool report")?.["gen_ai.agent.name"]).toBe("orchestrator");
  });

  it("survives an await and an intervening CHAIN, because it rides OTel context", async () => {
    await startAsCurrentSpan({ kind: SpanKind.AGENT, agentName: "planner" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await startAsCurrentSpan("step", { kind: SpanKind.CHAIN }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        await startAsCurrentSpan({ kind: SpanKind.TOOL, toolName: "get_weather" }, () => {});
      });
    });
    await client.flush();
    const byName = new Map(exporter.getFinishedSpans().map((s) => [s.name, s.attributes]));
    expect(byName.get("execute_tool get_weather")?.["gen_ai.agent.name"]).toBe("planner");
    // The key has no meaning on a CHAIN span, so nothing stamps it there.
    expect(byName.get("step")?.["gen_ai.agent.name"]).toBeUndefined();
  });

  it("does not rename the TOOL span: the name targets the tool, not the agent", async () => {
    await startAsCurrentSpan({ kind: SpanKind.AGENT, agentName: "planner" }, async () => {
      await startAsCurrentSpan({ kind: SpanKind.TOOL, toolName: "get_weather" }, () => {});
    });
    await client.flush();
    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names).toContain("execute_tool get_weather");
    expect(names).not.toContain("execute_tool planner");
  });

  it("says nothing when no agent encloses the call and none is configured", async () => {
    await startAsCurrentSpan({ kind: SpanKind.TOOL, toolName: "get_weather" }, () => {});
    await client.flush();
    const tool = exporter.getFinishedSpans()[0];
    expect(tool.attributes["gen_ai.agent.name"]).toBeUndefined();
  });

  it("opens no scope from startSpan, which never becomes current", async () => {
    // The documented limitation: a manual AGENT span activates no context, so
    // there is nothing for the tool below it to read.
    const agent = startSpan({ kind: SpanKind.AGENT, agentName: "planner" });
    await startAsCurrentSpan({ kind: SpanKind.TOOL, toolName: "get_weather" }, () => {});
    agent.end();
    await client.flush();
    const tool = exporter.getFinishedSpans().find((s) => s.name === "execute_tool get_weather");
    expect(tool?.attributes["gen_ai.agent.name"]).toBeUndefined();
  });

  it("carries it on a pending snapshot of a still-running tool call", async () => {
    await client.shutdown();
    const pendingExporter = new InMemorySpanExporter();
    client = init({
      spanExporter: pendingExporter,
      partialSpans: true,
      heartbeatTransport: async () => {},
    });
    await startAsCurrentSpan({ kind: SpanKind.AGENT, agentName: "planner" }, async () => {
      // Started, never ended inside the scope: this is the crashed-agent case.
      const tool = startSpan({ kind: SpanKind.TOOL, toolName: "get_weather" });
      await client.flush();
      const pending = pendingExporter
        .getFinishedSpans()
        .filter((s) => s.attributes["rius.span.pending"] === true);
      expect(pending.map((s) => s.name)).toContain("execute_tool get_weather");
      expect(
        pending.find((s) => s.name === "execute_tool get_weather")?.attributes["gen_ai.agent.name"],
      ).toBe("planner");
      tool.end();
    });
  });

  it("distinguishes the invoked agent from the executing one on the same key", async () => {
    await startAsCurrentSpan({ kind: SpanKind.AGENT, agentName: "orchestrator" }, async () => {
      // An invoke_agent span: the key names the agent this span INVOKES.
      await startAsCurrentSpan({ kind: SpanKind.AGENT, agentName: "researcher" }, () => {});
      // An execute_tool span: the same key names the agent RUNNING the tool.
      await startAsCurrentSpan({ kind: SpanKind.TOOL, toolName: "get_weather" }, () => {});
    });
    await client.flush();
    const byName = new Map(exporter.getFinishedSpans().map((s) => [s.name, s.attributes]));
    const invoked = byName.get("invoke_agent researcher");
    const executed = byName.get("execute_tool get_weather");
    expect(invoked?.["gen_ai.operation.name"]).toBe("invoke_agent");
    expect(invoked?.["gen_ai.agent.name"]).toBe("researcher");
    expect(executed?.["gen_ai.operation.name"]).toBe("execute_tool");
    expect(executed?.["gen_ai.agent.name"]).toBe("orchestrator");
  });
});

describe("the executing agent and the configured agent name", () => {
  let scoped: RiusClient;
  let scopedExporter: InMemorySpanExporter;

  beforeEach(async () => {
    await client.shutdown();
    scopedExporter = new InMemorySpanExporter();
    scoped = init({
      spanExporter: scopedExporter,
      agentName: "configured",
      heartbeatTransport: async () => {},
    });
  });
  afterEach(async () => {
    await scoped.shutdown();
  });

  it("falls back to it when no AGENT span encloses the tool call", async () => {
    await startAsCurrentSpan({ kind: SpanKind.TOOL, toolName: "get_weather" }, () => {});
    await scoped.flush();
    expect(scopedExporter.getFinishedSpans()[0].attributes["gen_ai.agent.name"]).toBe("configured");
  });

  it("loses to an enclosing agent, which is the more specific answer", async () => {
    await startAsCurrentSpan({ kind: SpanKind.AGENT, agentName: "planner" }, async () => {
      await startAsCurrentSpan({ kind: SpanKind.TOOL, toolName: "get_weather" }, () => {});
    });
    await scoped.flush();
    const tool = scopedExporter
      .getFinishedSpans()
      .find((s) => s.name === "execute_tool get_weather");
    expect(tool?.attributes["gen_ai.agent.name"]).toBe("planner");
  });

  it("does not reach a span of any other kind", async () => {
    await startAsCurrentSpan("step", { kind: SpanKind.CHAIN }, () => {});
    startSpan("retrieve", { kind: SpanKind.RETRIEVER, dataSourceId: "docs" }).end();
    await scoped.flush();
    for (const span of scopedExporter.getFinishedSpans()) {
      expect(span.attributes["gen_ai.agent.name"]).toBeUndefined();
    }
  });
});

// Verified against semantic-conventions-genai @ 8ffdf568e1b4391a99adb081db16e8102e36918e:
// on an execute_tool span gen_ai.tool.call.id is Recommended "if available"
// and gen_ai.tool.type is Recommended "if available" and sampling-relevant.
describe("tool-call identity on local tool spans", () => {
  it("sets both at creation on a TOOL span", async () => {
    startSpan({
      kind: SpanKind.TOOL,
      toolName: "get_weather",
      toolCallId: "call_mszuSIzqtI65i1wAUOE8w5H4",
      toolType: "function",
    }).end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.tool.call.id"]).toBe("call_mszuSIzqtI65i1wAUOE8w5H4");
    expect(span.attributes["gen_ai.tool.type"]).toBe("function");
  });

  it("names the span after the tool, never after the call id or the type", async () => {
    startSpan({
      kind: SpanKind.TOOL,
      toolName: "get_weather",
      toolCallId: "call_abc123",
      toolType: "extension",
    }).end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].name).toBe("execute_tool get_weather");
  });

  it("still names an untooled TOOL span after the bare operation", async () => {
    // Neither key may stand in for a missing tool name.
    startSpan({ kind: SpanKind.TOOL, toolCallId: "call_abc123", toolType: "function" }).end();
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.name).toBe("execute_tool");
    expect(span.attributes["gen_ai.tool.name"]).toBeUndefined();
  });

  it("ignores both on every other kind, where they would claim a call that is not there", async () => {
    for (const kind of [SpanKind.LLM, SpanKind.AGENT, SpanKind.RETRIEVER, SpanKind.CHAIN]) {
      startSpan(`s-${kind}`, { kind, toolCallId: "call_abc123", toolType: "function" }).end();
    }
    await client.flush();
    for (const span of exporter.getFinishedSpans()) {
      expect(
        span.attributes["gen_ai.tool.call.id"],
        `${span.name} leaked a call id`,
      ).toBeUndefined();
      expect(
        span.attributes["gen_ai.tool.type"],
        `${span.name} leaked a tool type`,
      ).toBeUndefined();
    }
  });

  it("omits each independently; neither is defaulted", async () => {
    startSpan({ kind: SpanKind.TOOL, toolName: "a", toolCallId: "call_1" }).end();
    startSpan({ kind: SpanKind.TOOL, toolName: "b", toolType: "datastore" }).end();
    await client.flush();
    const [first, second] = exporter.getFinishedSpans();
    expect(first.attributes["gen_ai.tool.call.id"]).toBe("call_1");
    expect(first.attributes["gen_ai.tool.type"]).toBeUndefined();
    expect(second.attributes["gen_ai.tool.type"]).toBe("datastore");
    expect(second.attributes["gen_ai.tool.call.id"]).toBeUndefined();
  });

  it("carries both through the scoped helper", async () => {
    await startAsCurrentSpan(
      { kind: SpanKind.TOOL, toolName: "get_weather", toolCallId: "call_2", toolType: "function" },
      () => {},
    );
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.tool.call.id"]).toBe("call_2");
    expect(span.attributes["gen_ai.tool.type"]).toBe("function");
  });

  it("carries both through observe", async () => {
    const wrapped = observe(async (city: string) => `sunny in ${city}`, {
      kind: SpanKind.TOOL,
      toolName: "get_weather",
      toolCallId: "call_3",
      toolType: "extension",
    });
    await wrapped("berlin");
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.tool.call.id"]).toBe("call_3");
    expect(span.attributes["gen_ai.tool.type"]).toBe("extension");
    expect(span.name).toBe("execute_tool get_weather");
  });
});
