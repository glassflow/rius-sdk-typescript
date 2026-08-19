import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterEach, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config.js";
import { HeartbeatSender, OpenRootSpanTracker } from "../src/heartbeat.js";

afterEach(() => vi.restoreAllMocks());

it("(1) an out-of-range RIUS_HEARTBEAT_INTERVAL env value warns and clamps", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const low = resolveConfig({}, { RIUS_HEARTBEAT_INTERVAL: "1" });
  expect(low.heartbeatIntervalMs).toBe(5000);
  const high = resolveConfig({}, { RIUS_HEARTBEAT_INTERVAL: "9999" });
  expect(high.heartbeatIntervalMs).toBe(300000);
  const delay = resolveConfig({}, { RIUS_PARTIAL_SPANS_DELAY: "600" });
  expect(delay.partialSpansDelayMs).toBe(60000);
  expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
    "[rius] heartbeatInterval=1 is outside [5, 300]; clamped to 5.",
    "[rius] heartbeatInterval=9999 is outside [5, 300]; clamped to 300.",
    "[rius] partialSpansDelay=600 is outside [0, 60]; clamped to 60.",
  ]);
});

it("(2) heartbeatEndpoint has exactly one slash for trailing-slash endpoints", () => {
  for (const endpoint of ["https://x.example", "https://x.example/", "https://x.example///"]) {
    expect(resolveConfig({ endpoint }).heartbeatEndpoint).toBe("https://x.example/v1/heartbeat");
  }
  expect(resolveConfig({}, { RIUS_ENDPOINT: "https://e.example//" }).heartbeatEndpoint).toBe(
    "https://e.example/v1/heartbeat",
  );
  // path-carrying endpoints keep their path
  expect(resolveConfig({ endpoint: "https://x.example/base/" }).heartbeatEndpoint).toBe(
    "https://x.example/base/v1/heartbeat",
  );
});

it("(3) caps open_traces at 32 with 40 REAL root spans, count reports 40", async () => {
  const tracker = new OpenRootSpanTracker();
  const provider = new BasicTracerProvider({ spanProcessors: [tracker] });
  const tracer = provider.getTracer("t");
  const spans = Array.from({ length: 40 }, (_, i) => tracer.startSpan(`root-${i}`));

  const payloads: Record<string, unknown>[] = [];
  const sender = new HeartbeatSender({
    url: "http://x.invalid",
    headers: {},
    intervalMs: 999999,
    agentName: "a",
    instanceId: "test-instance",
    tracker,
    transport: async (p) => void payloads.push(p),
  });
  sender.start();
  await vi.waitUntil(() => payloads.length > 0);

  const openTraces = payloads[0].open_traces as string[];
  expect(payloads[0].open_trace_count).toBe(40);
  expect(openTraces).toHaveLength(32);
  // the cap keeps the FIRST 32 in open order, and they are real trace ids
  expect(openTraces).toEqual(spans.slice(0, 32).map((s) => s.spanContext().traceId));
  for (const s of spans) s.end();
  await sender.stop();
});
