import { SpanKind as OtelSpanKind } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
      .filter((s) => s.attributes["glassflow.span.pending"] === true);
    obs.end();
    expect(pending).toHaveLength(1);
    expect(pending[0].attributes["gen_ai.tool.name"]).toBe("weather");
    expect(pending[0].attributes["gen_ai.operation.name"]).toBe("execute_tool");
    expect(pending[0].attributes["input.value"]).toBeUndefined();
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
