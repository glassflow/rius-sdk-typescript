import { context, trace } from "@opentelemetry/api";
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { init } from "../src/client.js";
import { startGeneration } from "../src/generation.js";
import {
  PENDING_IDENTITY_ATTRIBUTES,
  PENDING_IDENTITY_PREFIXES,
  RIUS_SPAN_PENDING,
  SpanKind,
} from "../src/semconv.js";
import { withSession } from "../src/session.js";
import { startAsCurrentSpan } from "../src/spans.js";

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

    const pending = exporter.spans.filter((s) => s.attributes[RIUS_SPAN_PENDING] === true);
    const finals = exporter.spans.filter((s) => s.attributes[RIUS_SPAN_PENDING] !== true);
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

    const pending = exporter.spans.find((s) => s.attributes[RIUS_SPAN_PENDING] === true);
    const final = exporter.spans.find((s) => s.attributes[RIUS_SPAN_PENDING] !== true);
    expect(pending?.attributes["gen_ai.request.model"]).toBe("gpt-4o");
    expect(Object.keys(pending?.attributes ?? {}).some((k) => k in CONTENTY)).toBe(false);
    expect(final?.attributes["input.value"]).toBe("[REDACTED]");
  });

  it("carries the invoked agent's version on an AGENT span's pending snapshot", async () => {
    // Set at CREATION precisely so it reaches the snapshot: a live view of a
    // still-running agent must say which version of that agent is running.
    const exporter = new Capture();
    client = init({ spanExporter: exporter, partialSpans: true, heartbeat: false });
    const done = startAsCurrentSpan(
      "plan",
      { kind: SpanKind.AGENT, agentName: "planner", agentVersion: "1.0.0" },
      async () => 1,
    );
    await done;
    await client.flush();

    const pending = exporter.spans.find((s) => s.attributes[RIUS_SPAN_PENDING] === true);
    expect(pending?.attributes["gen_ai.agent.name"]).toBe("planner");
    expect(pending?.attributes["gen_ai.agent.version"]).toBe("1.0.0");
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
      (s) => s.name === "child" && s.attributes[RIUS_SPAN_PENDING] === true,
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

    const pending = exporter.spans.find((s) => s.attributes[RIUS_SPAN_PENDING] === true);
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
    expect(exporter.spans.filter((s) => s.attributes[RIUS_SPAN_PENDING] === true)).toHaveLength(0);
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
    expect(exporter.spans.filter((s) => s.attributes[RIUS_SPAN_PENDING] === true)).toHaveLength(1);
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
    expect(exporter.spans.filter((s) => s.attributes[RIUS_SPAN_PENDING] === true)).toHaveLength(1);
    span.end();
  });
});

describe("request parameters on a pending snapshot", () => {
  /** One pending and one final span, from a partial-spans pipeline. */
  function split(spans: readonly ReadableSpan[]): { pending: ReadableSpan; final: ReadableSpan } {
    const pending = spans.filter((s) => s.attributes[RIUS_SPAN_PENDING] === true);
    const finals = spans.filter((s) => s.attributes[RIUS_SPAN_PENDING] !== true);
    expect(pending).toHaveLength(1);
    expect(finals).toHaveLength(1);
    return { pending: pending[0], final: finals[0] };
  }

  it("carries both request namespaces", async () => {
    // Chosen before the call runs, so the live view must already show them:
    // a stuck or runaway call raises exactly the question of how it was
    // asked to run.
    const exporter = new Capture();
    client = init({ spanExporter: exporter, partialSpans: true, heartbeat: false });
    startGeneration("chat", { modelParameters: { temperature: 0.7, my_custom_knob: 3 } }).end();
    await client.flush();
    const { pending } = split(exporter.spans);
    expect(pending.attributes["gen_ai.request.temperature"]).toBe(0.7);
    expect(pending.attributes["rius.request.my_custom_knob"]).toBe(3);
  });

  it("does not leak tool definitions passed as a model parameter", async () => {
    // rius.request.* rides snapshots by prefix, so a `tools` parameter
    // reaches one. Masking runs at export and covers pendings too; the
    // snapshot must not be the way definitions escape captureContent: false.
    const exporter = new Capture();
    client = init({
      spanExporter: exporter,
      partialSpans: true,
      captureContent: false,
      heartbeat: false,
    });
    startGeneration("chat", {
      modelParameters: {
        tools: [{ description: "SECRET" }],
        functions: [{ description: "SECRET" }],
        temperature: 0.7,
      },
    }).end();
    await client.flush();
    const { pending, final } = split(exporter.spans);
    for (const span of [pending, final]) {
      expect(span.attributes["rius.request.tools"]).toBeUndefined();
      expect(span.attributes["rius.request.functions"]).toBeUndefined();
      expect(JSON.stringify(span.attributes)).not.toContain("SECRET");
    }
    expect(pending.attributes["gen_ai.request.temperature"]).toBe(0.7);
  });

  /**
   * THE INVERTED GUARD. The allowlist-coverage test walks what the creation
   * builders set and asserts each key is allowlisted, which catches a missing
   * allowlist entry. It cannot catch the opposite mistake: a key that IS
   * allowlisted but is written after the span exists, so the snapshot built at
   * onStart never sees it. That mistake was live for model parameters for the
   * whole life of partial spans, with the prefix rule sitting in the
   * allowlist looking correct because nothing exercised it.
   *
   * So: a generation with every option populated and every post-call setter
   * called, and every allowlisted attribute the FINAL span carries must be on
   * the snapshot too.
   */
  it("carries every allowlisted attribute the finished generation ends up with", async () => {
    // Allowlisted keys that legitimately cannot be known when the span opens.
    // Each one is an argued exemption, so a new late write has to be defended
    // in a diff rather than passing unnoticed.
    const LATE_EXEMPTIONS = new Set([
      // Set by recordFirstToken: whether the response streamed is only
      // answerable once a first chunk has arrived, after the span started.
      "gen_ai.request.stream",
    ]);
    const exporter = new Capture();
    client = init({ spanExporter: exporter, partialSpans: true, heartbeat: false });
    withSession("sess-1", () => {
      const generation = startGeneration({
        model: "gpt-4o",
        provider: "openai",
        input: [{ role: "user", content: "hello" }],
        modelParameters: {
          temperature: 0.7,
          max_completion_tokens: 256, // a recognised provider spelling
          my_custom_knob: 3, // lands in rius.request.*
        },
        operation: "chat",
        reasoningLevel: "high",
        tools: [{ name: "get_weather" }],
        userId: "u-1",
        outputType: "json",
      });
      generation.recordFirstToken();
      generation.setModel("gpt-4o-2026-08-06");
      generation.setResponseId("resp_1");
      generation.setUsage({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 2,
        cacheWriteInputTokens: 1,
        reasoningOutputTokens: 3,
      });
      generation.setFinishReasons("stop");
      generation.setOutput([{ role: "assistant", content: "hi" }]);
      generation.end();
    });
    await client.flush();
    const { pending, final } = split(exporter.spans);

    const missing = Object.keys(final.attributes).filter(
      (key) =>
        (PENDING_IDENTITY_ATTRIBUTES.has(key) ||
          PENDING_IDENTITY_PREFIXES.some((prefix) => key.startsWith(prefix))) &&
        !LATE_EXEMPTIONS.has(key) &&
        !(key in pending.attributes),
    );
    expect(
      missing,
      "allowlisted but written too late to reach the pending snapshot: set it at creation, " +
        "or add it to LATE_EXEMPTIONS with the reason it cannot be known at span start",
    ).toEqual([]);
    // The guard has something to bite on: both namespaces are on the final span.
    expect(final.attributes["gen_ai.request.max_tokens"]).toBe(256);
    expect(final.attributes["rius.request.my_custom_knob"]).toBe(3);
    expect(final.attributes["gen_ai.request.reasoning.level"]).toBe("high");
  });
});
