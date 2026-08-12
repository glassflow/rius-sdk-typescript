import { ROOT_CONTEXT, TraceFlags, context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RiusClient, getTracer, init } from "../src/client.js";
import { REGISTRY } from "../src/instrumentation.js";
import { startAsCurrentSpan } from "../src/spans.js";

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

  it("strips exception content from a recorded error when captureContent is false", async () => {
    const exporter = new InMemorySpanExporter();
    client = init({ captureContent: false, spanExporter: exporter });

    const leak = 'BadRequest 400: {"messages":[{"role":"user","content":"<PII>"}]}';
    await expect(
      startAsCurrentSpan("s", () => {
        throw new Error(leak);
      }),
    ).rejects.toThrow(leak);
    await client.flush();

    const event = exporter.getFinishedSpans()[0].events[0];
    expect(event.name).toBe("exception");
    expect(event.attributes?.["exception.type"]).toBe("Error");
    expect(event.attributes?.["exception.message"]).toBeUndefined();
    expect(event.attributes?.["exception.stacktrace"]).toBeUndefined();
  });

  it("keeps the exception message when captureContent is left at its default", async () => {
    const exporter = new InMemorySpanExporter();
    client = init({ mask: () => "[redacted]", spanExporter: exporter });

    await expect(
      startAsCurrentSpan("s", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await client.flush();

    expect(exporter.getFinishedSpans()[0].events[0].attributes?.["exception.message"]).toBe("boom");
  });

  it("loads no integration and reports none when disabled", async () => {
    // Spying on every registry entry's load() is what proves the short-circuit:
    // enabling an integration registers hooks and patches third-party
    // prototypes in the caller's process, and someone who disables this SDK must
    // be left with an unpatched process, not merely an unexported one.
    const loads = REGISTRY.map((entry) => vi.spyOn(entry, "load"));
    client = init({ disabled: true, spanExporter: new InMemorySpanExporter() });
    await expect(client.ready).resolves.toEqual([]);
    for (const load of loads) expect(load).not.toHaveBeenCalled();
  });

  it("still registers the provider when disabled, so getTracer() keeps working", async () => {
    client = init({ disabled: true, spanExporter: new InMemorySpanExporter() });
    const span = getTracer().startSpan("s");
    expect(span.spanContext().traceId).not.toBe("00000000000000000000000000000000");
    span.end();
  });

  it("is not constructible outside init()", () => {
    // Compile-time assertion, enforced by `npm run typecheck`: a
    // caller-constructed client is not the global one, so its shutdown() would
    // skip trace.disable() and silently leave the SDK registered.
    // @ts-expect-error the constructor is private; init() is the sole factory.
    expect(() => new RiusClient()).toBeTypeOf("function");
  });

  it("drops a child of a remote UNSAMPLED parent even at sampleRate 1", async () => {
    const exporter = new InMemorySpanExporter();
    client = init({ sampleRate: 1, spanExporter: exporter });

    startSpanUnderRemoteParent("child", TraceFlags.NONE);

    await client.flush();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
