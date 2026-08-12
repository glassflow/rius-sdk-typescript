import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { SpanKind } from "../src/semconv.js";
import { startAsCurrentSpan, startSpan } from "../src/spans.js";

let exporter: InMemorySpanExporter;
let client: RiusClient;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  client = init({ spanExporter: exporter });
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
