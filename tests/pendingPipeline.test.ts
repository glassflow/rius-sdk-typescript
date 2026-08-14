import { context, trace } from "@opentelemetry/api";
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { init } from "../src/client.js";
import { GLASSFLOW_SPAN_PENDING } from "../src/semconv.js";

class Capture implements SpanExporter {
  readonly spans: ReadableSpan[] = [];
  export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
    // snapshot the attribute bag: masking mutates in place
    for (const s of spans)
      this.spans.push({ ...s, attributes: { ...s.attributes } } as ReadableSpan);
    cb({ code: 0 });
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

const CONTENTY = {
  "input.value": "SECRET INPUT",
  "gen_ai.input.messages": "SECRET MESSAGES",
  "llm.input_messages.0.message.content": "SECRET FLAT",
  "gen_ai.prompt.0.content": "SECRET PROMPT",
};
const IDENTITY = {
  "openinference.span.kind": "LLM",
  "gen_ai.operation.name": "chat",
  "gen_ai.provider.name": "openai",
  "gen_ai.tool.name": "search",
  "gen_ai.request.model": "gpt-4o",
};

let client: Awaited<ReturnType<typeof init>> | undefined;
afterEach(async () => {
  await client?.shutdown();
  client = undefined;
});

describe("pending privacy through the real init() pipeline", () => {
  it("captureContent:false keeps identity on pendings and strips content everywhere", async () => {
    const exporter = new Capture();
    client = init({
      spanExporter: exporter,
      partialSpans: true,
      captureContent: false,
      heartbeat: false,
      serviceName: "privacy-test",
    });
    const tracer = trace.getTracer("t");
    const span = tracer.startSpan("llm", { attributes: { ...IDENTITY, ...CONTENTY } });
    span.end();
    await client.flush();

    const pending = exporter.spans.filter((s) => s.attributes[GLASSFLOW_SPAN_PENDING] === true);
    const finals = exporter.spans.filter((s) => s.attributes[GLASSFLOW_SPAN_PENDING] !== true);
    expect(pending).toHaveLength(1);
    expect(finals).toHaveLength(1);

    // (a) identity attributes survive masking intact on the pending
    for (const [k, v] of Object.entries(IDENTITY)) {
      expect(pending[0].attributes[k], `identity ${k} on pending`).toBe(v);
    }
    // (b) no content on the pending, and none on the final either
    for (const k of Object.keys(CONTENTY)) {
      expect(pending[0].attributes[k], `content ${k} on pending`).toBeUndefined();
      expect(finals[0].attributes[k], `content ${k} on final`).toBeUndefined();
    }
  });

  it("a mask function does not corrupt or reach pending identity attributes", async () => {
    const exporter = new Capture();
    client = init({
      spanExporter: exporter,
      partialSpans: true,
      mask: () => "[REDACTED]",
      heartbeat: false,
    });
    const span = trace
      .getTracer("t")
      .startSpan("llm", { attributes: { ...IDENTITY, ...CONTENTY } });
    span.end();
    await client.flush();

    const pending = exporter.spans.find((s) => s.attributes[GLASSFLOW_SPAN_PENDING] === true);
    const final = exporter.spans.find((s) => s.attributes[GLASSFLOW_SPAN_PENDING] !== true);
    expect(pending?.attributes["gen_ai.request.model"]).toBe("gpt-4o");
    expect(Object.keys(pending?.attributes ?? {}).some((k) => k in CONTENTY)).toBe(false);
    expect(final?.attributes["input.value"]).toBe("[REDACTED]");
  });

  it("preserves parent linkage and identity for a CHILD span pending", async () => {
    const exporter = new Capture();
    client = init({ spanExporter: exporter, partialSpans: true, heartbeat: false });
    const tracer = trace.getTracer("t");
    const parent = tracer.startSpan("parent");
    const ctx = trace.setSpan(context.active(), parent);
    const child = tracer.startSpan("child", { attributes: IDENTITY }, ctx);
    child.end();
    parent.end();
    await client.flush();

    const childPending = exporter.spans.find(
      (s) => s.name === "child" && s.attributes[GLASSFLOW_SPAN_PENDING] === true,
    );
    expect(childPending).toBeDefined();
    expect(childPending?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(childPending?.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(childPending?.endTime).toEqual(childPending?.startTime);
    expect(childPending?.duration).toEqual([0, 0]);
  });

  it("content set AFTER start never lands on the pending (debounced)", async () => {
    const exporter = new Capture();
    client = init({
      spanExporter: exporter,
      partialSpans: true,
      partialSpansDelay: 0.02,
      heartbeat: false,
    });
    const span = trace.getTracer("t").startSpan("llm", { attributes: IDENTITY });
    span.setAttribute("input.value", "LATE SECRET");
    await new Promise((r) => setTimeout(r, 60));
    await client.flush();

    const pending = exporter.spans.find((s) => s.attributes[GLASSFLOW_SPAN_PENDING] === true);
    expect(pending).toBeDefined();
    expect(pending?.attributes["input.value"]).toBeUndefined();
    span.end();
  });

  it("a span that ends within the delay emits no pending at all", async () => {
    const exporter = new Capture();
    client = init({
      spanExporter: exporter,
      partialSpans: true,
      partialSpansDelay: 1,
      heartbeat: false,
    });
    const span = trace.getTracer("t").startSpan("quick");
    span.end();
    await new Promise((r) => setTimeout(r, 50));
    await client.flush();
    expect(
      exporter.spans.filter((s) => s.attributes[GLASSFLOW_SPAN_PENDING] === true),
    ).toHaveLength(0);
  });
});

describe("lifecycle interactions", () => {
  it("heartbeat:false + partialSpans:true wires pendings and no sender", async () => {
    const exporter = new Capture();
    const pings: unknown[] = [];
    client = init({
      spanExporter: exporter,
      partialSpans: true,
      heartbeat: false,
      heartbeatTransport: async (p) => void pings.push(p),
    });
    trace.getTracer("t").startSpan("s").end();
    await client.flush();
    expect(
      exporter.spans.filter((s) => s.attributes[GLASSFLOW_SPAN_PENDING] === true),
    ).toHaveLength(1);
    await client.shutdown();
    client = undefined;
    expect(pings).toHaveLength(0);
  });

  it("repeated init/shutdown cycles leak no beforeExit listeners", async () => {
    const before = process.listenerCount("beforeExit");
    for (let i = 0; i < 5; i++) {
      const c = init({
        spanExporter: new Capture(),
        heartbeat: true,
        heartbeatTransport: async () => {},
        partialSpans: true,
      });
      await c.shutdown();
    }
    expect(process.listenerCount("beforeExit")).toBe(before);
  });

  it("disabled mode wires neither pendings nor heartbeat", async () => {
    const exporter = new Capture();
    const pings: unknown[] = [];
    client = init({
      spanExporter: exporter,
      disabled: true,
      partialSpans: true,
      heartbeat: true,
      heartbeatTransport: async (p) => void pings.push(p),
    });
    trace.getTracer("t").startSpan("s").end();
    await client.flush();
    expect(exporter.spans).toHaveLength(0);
    expect(pings).toHaveLength(0);
  });

  it("shutdown sends the stopped ping BEFORE the provider tears down", async () => {
    const order: string[] = [];
    const exporter: SpanExporter = {
      export: (_s, cb) => cb({ code: 0 }),
      shutdown: async () => void order.push("provider-shutdown"),
      forceFlush: async () => {},
    };
    const c = init({
      spanExporter: exporter,
      heartbeat: true,
      heartbeatTransport: async (p) => {
        order.push(p.stopped === true ? "stopped-ping" : "ping");
      },
    });
    await c.shutdown();
    expect(order.indexOf("stopped-ping")).toBeLessThan(order.indexOf("provider-shutdown"));
    expect(order.filter((o) => o === "stopped-ping")).toHaveLength(1);
  });

  it("flush() while a debounce timer is pending does not drop the pending", async () => {
    const exporter = new Capture();
    client = init({
      spanExporter: exporter,
      partialSpans: true,
      partialSpansDelay: 0.05,
      heartbeat: false,
    });
    const span = trace.getTracer("t").startSpan("long");
    await client.flush(); // mid-operation flush
    await new Promise((r) => setTimeout(r, 120));
    await client.flush();
    expect(
      exporter.spans.filter((s) => s.attributes[GLASSFLOW_SPAN_PENDING] === true),
    ).toHaveLength(1);
    span.end();
  });
});
