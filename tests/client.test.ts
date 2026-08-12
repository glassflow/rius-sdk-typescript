import { ROOT_CONTEXT, TraceFlags, context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RiusClient, getTracer, init } from "../src/client.js";

let client: RiusClient | undefined;

/** Starts and ends a span whose parent arrived over the wire with `flags`. */
function startSpanUnderRemoteParent(name: string, flags: TraceFlags): void {
  const parent = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: flags,
    isRemote: true,
  });
  context.with(parent, () => {
    getTracer().startSpan(name).end();
  });
}

afterEach(async () => {
  await client?.shutdown();
  client = undefined;
  vi.restoreAllMocks();
});

describe("init", () => {
  it("exports spans through an injected exporter", async () => {
    const exporter = new InMemorySpanExporter();
    client = init({ apiKey: "k", serviceName: "svc", spanExporter: exporter });
    getTracer().startSpan("s").end();
    await client.flush();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["s"]);
  });

  it("stamps the wire-visible scope name on every span", async () => {
    const exporter = new InMemorySpanExporter();
    client = init({ spanExporter: exporter });
    getTracer().startSpan("s").end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].instrumentationScope.name).toBe("glassflow");
  });

  it("stamps the service name on the resource", async () => {
    const exporter = new InMemorySpanExporter();
    client = init({ serviceName: "svc", spanExporter: exporter });
    getTracer().startSpan("s").end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].resource.attributes["service.name"]).toBe("svc");
  });

  it("creates spans but exports nothing when disabled", async () => {
    const exporter = new InMemorySpanExporter();
    client = init({ disabled: true, spanExporter: exporter });
    getTracer().startSpan("s").end();
    await client.flush();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("returns the existing client and warns when called twice", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exporter = new InMemorySpanExporter();
    client = init({ spanExporter: exporter });
    expect(init({ spanExporter: new InMemorySpanExporter() })).toBe(client);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("allows a fresh init after shutdown", async () => {
    const first = init({ spanExporter: new InMemorySpanExporter() });
    await first.shutdown();

    const exporter = new InMemorySpanExporter();
    client = init({ spanExporter: exporter });
    expect(client).not.toBe(first);
    getTracer().startSpan("s").end();
    await client.flush();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["s"]);
  });

  it("strips content when captureContent is false", async () => {
    const exporter = new InMemorySpanExporter();
    client = init({ captureContent: false, spanExporter: exporter });
    const span = getTracer().startSpan("s");
    span.setAttribute("input.value", "secret");
    span.end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["input.value"]).toBeUndefined();
  });

  it("applies mask while still capturing content", async () => {
    const exporter = new InMemorySpanExporter();
    client = init({ mask: () => "[redacted]", spanExporter: exporter });
    const span = getTracer().startSpan("s");
    span.setAttribute("input.value", "secret");
    span.end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["input.value"]).toBe("[redacted]");
  });

  it("leaves content untouched when neither captureContent nor mask is set", async () => {
    const exporter = new InMemorySpanExporter();
    client = init({ spanExporter: exporter });
    const span = getTracer().startSpan("s");
    span.setAttribute("input.value", "secret");
    span.end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["input.value"]).toBe("secret");
  });

  it("drops a root span the ratio sampler rejects", async () => {
    const exporter = new InMemorySpanExporter();
    client = init({ sampleRate: 0, spanExporter: exporter });
    getTracer().startSpan("root").end();
    await client.flush();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("exports a child of a remote SAMPLED parent even at sampleRate 0", async () => {
    const exporter = new InMemorySpanExporter();
    client = init({ sampleRate: 0, spanExporter: exporter });

    startSpanUnderRemoteParent("child", TraceFlags.SAMPLED);

    await client.flush();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["child"]);
  });

  it("drops a child of a remote UNSAMPLED parent even at sampleRate 1", async () => {
    const exporter = new InMemorySpanExporter();
    client = init({ sampleRate: 1, spanExporter: exporter });

    startSpanUnderRemoteParent("child", TraceFlags.NONE);

    await client.flush();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
