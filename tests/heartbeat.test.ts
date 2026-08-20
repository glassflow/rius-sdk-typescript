import { readFileSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { context, trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeartbeatSender, type HeartbeatTransport, OpenRootSpanTracker } from "../src/heartbeat.js";

const packageVersion = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf-8")) as {
    version: string;
  }
).version;

const SENT_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("OpenRootSpanTracker", () => {
  it("counts only root spans open right now, in start order", () => {
    const tracker = new OpenRootSpanTracker();
    const provider = new BasicTracerProvider({ spanProcessors: [tracker] });
    const tracer = provider.getTracer("test");

    const rootA = tracer.startSpan("root-a");
    const rootB = tracer.startSpan("root-b");
    expect(tracker.openTraceIds()).toEqual([
      rootA.spanContext().traceId,
      rootB.spanContext().traceId,
    ]);

    // A child span never touches the tracked set.
    const parentCtx = trace.setSpan(context.active(), rootA);
    const child = tracer.startSpan("child", undefined, parentCtx);
    child.end();

    rootA.end();
    expect(tracker.openTraceIds()).toEqual([rootB.spanContext().traceId]);

    rootB.end();
    expect(tracker.openTraceIds()).toEqual([]);
  });

  it("dedups by trace id with a count, so ending one of two same-trace roots keeps it open", () => {
    const tracker = new OpenRootSpanTracker();
    const traceId = "0102030405060708090a0b0c0d0e0f10";
    const spanA = { parentSpanContext: undefined, spanContext: () => ({ traceId }) } as never;
    const spanB = { parentSpanContext: undefined, spanContext: () => ({ traceId }) } as never;

    tracker.onStart(spanA, {} as never);
    tracker.onStart(spanB, {} as never);
    expect(tracker.openTraceIds()).toEqual([traceId]);

    tracker.onEnd(spanA);
    expect(tracker.openTraceIds()).toEqual([traceId]);

    tracker.onEnd(spanB);
    expect(tracker.openTraceIds()).toEqual([]);
  });

  it("ignores a span with a parent", () => {
    const tracker = new OpenRootSpanTracker();
    const child = {
      parentSpanContext: { traceId: "x" },
      spanContext: () => ({ traceId: "child-trace" }),
    } as never;

    tracker.onStart(child, {} as never);
    expect(tracker.openTraceIds()).toEqual([]);
  });
});

function fakeTracker(traceIds: string[]): OpenRootSpanTracker {
  return { openTraceIds: () => traceIds } as OpenRootSpanTracker;
}

describe("HeartbeatSender", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the first ping immediately with the full payload shape", () => {
    const transport = vi.fn<HeartbeatTransport>().mockResolvedValue(undefined);
    const sender = new HeartbeatSender({
      url: "http://example.invalid/v1/heartbeat",
      headers: {},
      intervalMs: 15_000,
      agentName: "my-agent",
      instanceId: "test-instance",
      tracker: fakeTracker(["trace-1"]),
      transport,
    });

    sender.start();

    expect(transport).toHaveBeenCalledTimes(1);
    const [payload, timeoutMs] = transport.mock.calls[0] ?? [];
    expect(payload).toEqual({
      v: 1,
      instance_id: sender.instanceId,
      agent_name: "my-agent",
      sent_at: expect.stringMatching(SENT_AT_PATTERN),
      sdk_language: "typescript",
      sdk_version: packageVersion,
      open_traces: ["trace-1"],
      open_trace_count: 1,
    });
    expect(timeoutMs).toBe(3000);
  });

  it("carries the injected instanceId, the same identity spans get as service.instance.id", () => {
    const transport = vi.fn<HeartbeatTransport>().mockResolvedValue(undefined);
    const sender = new HeartbeatSender({
      url: "http://example.invalid",
      headers: {},
      intervalMs: 15_000,
      agentName: "a",
      instanceId: "injected-identity",
      tracker: fakeTracker([]),
      transport,
    });
    sender.start();
    expect(sender.instanceId).toBe("injected-identity");
    expect(transport.mock.calls[0]?.[0]?.instance_id).toBe("injected-identity");
  });

  it("pings again on every interval tick", () => {
    const transport = vi.fn<HeartbeatTransport>().mockResolvedValue(undefined);
    const sender = new HeartbeatSender({
      url: "http://example.invalid",
      headers: {},
      intervalMs: 15_000,
      agentName: "my-agent",
      instanceId: "test-instance",
      tracker: fakeTracker([]),
      transport,
    });

    sender.start();
    expect(transport).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(15_000);
    expect(transport).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(30_000);
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it("caps open_traces at 32 while open_trace_count reports the real number", () => {
    const traceIds = Array.from({ length: 40 }, (_, i) => `trace-${i}`);
    const transport = vi.fn<HeartbeatTransport>().mockResolvedValue(undefined);
    const sender = new HeartbeatSender({
      url: "http://example.invalid",
      headers: {},
      intervalMs: 15_000,
      agentName: "my-agent",
      instanceId: "test-instance",
      tracker: fakeTracker(traceIds),
      transport,
    });

    sender.start();

    const [payload] = transport.mock.calls[0] ?? [];
    const body = payload as { open_traces: string[]; open_trace_count: number };
    expect(body.open_traces).toHaveLength(32);
    expect(body.open_traces).toEqual(traceIds.slice(0, 32));
    expect(body.open_trace_count).toBe(40);
  });

  it("sends stopped: true exactly once on stop(), and a second stop() is a no-op", async () => {
    const transport = vi.fn<HeartbeatTransport>().mockResolvedValue(undefined);
    const sender = new HeartbeatSender({
      url: "http://example.invalid",
      headers: {},
      intervalMs: 15_000,
      agentName: "my-agent",
      instanceId: "test-instance",
      tracker: fakeTracker([]),
      transport,
    });

    sender.start();
    transport.mockClear();

    await sender.stop();
    expect(transport).toHaveBeenCalledTimes(1);
    const [payload, timeoutMs] = transport.mock.calls[0] ?? [];
    expect((payload as { stopped?: boolean }).stopped).toBe(true);
    expect(timeoutMs).toBe(1000);

    await sender.stop();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("never sends stopped: false on a regular ping", () => {
    const transport = vi.fn<HeartbeatTransport>().mockResolvedValue(undefined);
    const sender = new HeartbeatSender({
      url: "http://example.invalid",
      headers: {},
      intervalMs: 15_000,
      agentName: "my-agent",
      instanceId: "test-instance",
      tracker: fakeTracker([]),
      transport,
    });

    sender.start();

    const [payload] = transport.mock.calls[0] ?? [];
    expect(payload).not.toHaveProperty("stopped");
  });

  it("stops the interval so no further pings go out after stop()", async () => {
    const transport = vi.fn<HeartbeatTransport>().mockResolvedValue(undefined);
    const sender = new HeartbeatSender({
      url: "http://example.invalid",
      headers: {},
      intervalMs: 15_000,
      agentName: "my-agent",
      instanceId: "test-instance",
      tracker: fakeTracker([]),
      transport,
    });

    sender.start();
    await sender.stop();
    transport.mockClear();

    vi.advanceTimersByTime(60_000);
    expect(transport).not.toHaveBeenCalled();
  });

  it("warns once on a throwing transport and never throws into the caller", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transport = vi.fn<HeartbeatTransport>().mockRejectedValue(new Error("network down"));
    const sender = new HeartbeatSender({
      url: "http://example.invalid",
      headers: {},
      intervalMs: 15_000,
      agentName: "my-agent",
      instanceId: "test-instance",
      tracker: fakeTracker([]),
      transport,
    });

    expect(() => sender.start()).not.toThrow();
    // Flush the microtask queue so the rejected first ping is handled.
    await vi.runOnlyPendingTimersAsync();

    vi.advanceTimersByTime(15_000);
    await vi.runOnlyPendingTimersAsync();
    vi.advanceTimersByTime(15_000);
    await vi.runOnlyPendingTimersAsync();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/^\[rius\] /);

    warn.mockRestore();
  });
});

describe("default HTTP transport", () => {
  /** A real local server, so the default transport is proven end to end (no fetch mocking). */
  async function stubServer(
    handler: (request: http.IncomingMessage, body: string) => { status: number },
  ): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const { status } = handler(request, Buffer.concat(chunks).toString("utf-8"));
        response.writeHead(status, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test setup: no port");
    return {
      url: `http://127.0.0.1:${address.port}/v1/heartbeat`,
      close: () =>
        new Promise((resolve) => {
          // fetch keeps a pooled connection to the host alive after the
          // response. Node 18's server.close() waits for idle connections to
          // go away on their own, so it never settles and the test times out;
          // Node 19+ drops them itself. Closing them explicitly makes the
          // teardown behave the same on every supported version.
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    };
  }

  it("posts JSON with content-type and caller headers, and resolves on 2xx", async () => {
    let received: { method?: string; headers?: http.IncomingHttpHeaders; body?: string } = {};
    const stub = await stubServer((request, body) => {
      received = { method: request.method, headers: request.headers, body };
      return { status: 200 };
    });

    try {
      const sender = new HeartbeatSender({
        url: stub.url,
        headers: { authorization: "Bearer test-key" },
        intervalMs: 15_000,
        agentName: "my-agent",
        instanceId: "test-instance",
        tracker: fakeTracker([]),
      });
      sender.start();
      // Real setInterval/setTimeout here (fake timers are not active in this
      // describe block); give the in-flight request a turn to complete.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await sender.stop();

      expect(received.method).toBe("POST");
      expect(received.headers?.["content-type"]).toBe("application/json");
      expect(received.headers?.authorization).toBe("Bearer test-key");
      const body = JSON.parse(received.body ?? "{}");
      expect(body.sdk_language).toBe("typescript");
    } finally {
      await stub.close();
    }
  });

  it("rejects on a non-2xx response", async () => {
    const stub = await stubServer(() => ({ status: 500 }));
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const sender = new HeartbeatSender({
        url: stub.url,
        headers: {},
        intervalMs: 15_000,
        agentName: "my-agent",
        instanceId: "test-instance",
        tracker: fakeTracker([]),
      });
      sender.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
      await sender.stop();
    } finally {
      await stub.close();
    }
  });
});
