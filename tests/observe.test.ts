import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("observe with kind TOOL", () => {
  it("carries gen_ai.tool.name equal to the span name, explicit or derived", async () => {
    const named = observe(async () => 1, { name: "search-docs", kind: SpanKind.TOOL });
    async function lookup(): Promise<number> {
      return 2;
    }
    const derived = observe(lookup, { kind: SpanKind.TOOL });
    await named();
    await derived();
    await client.flush();
    const byName = new Map(exporter.getFinishedSpans().map((s) => [s.name, s.attributes]));
    expect(byName.get("search-docs")?.["gen_ai.tool.name"]).toBe("search-docs");
    expect(byName.get("lookup")?.["gen_ai.tool.name"]).toBe("lookup");
  });
});
