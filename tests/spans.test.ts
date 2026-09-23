import { SpanKind as OtelSpanKind } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RiusClient, init } from "../src/client.js";
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
