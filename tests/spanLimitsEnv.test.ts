import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RiusClient, getTracer, init } from "../src/client.js";
import { DEFAULT_SPAN_ATTRIBUTE_COUNT_LIMIT } from "../src/client.js";

/**
 * The span attribute COUNT limit init() applies, and the environment variables
 * that override it. OpenTelemetry's default is 128, which a multi-turn agent
 * call instrumented by OpenInference (one attribute per message field and per
 * tool field) passes within a few turns; the span then silently refuses its
 * newest keys, which are the usage, the output and the finish reason.
 */

let client: RiusClient | undefined;
let exporter: InMemorySpanExporter;

afterEach(async () => {
  await client?.shutdown();
  client = undefined;
  vi.unstubAllEnvs();
});

/** Ends one native span carrying `count` attributes; returns how many it kept. */
async function keptOf(count: number): Promise<{ kept: number; dropped: number }> {
  exporter = new InMemorySpanExporter();
  client = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
  const span = getTracer().startSpan("wide");
  for (let i = 0; i < count; i++) span.setAttribute(`app.k${i}`, i);
  span.end();
  await client.flush();
  const [finished] = exporter.getFinishedSpans();
  const kept = Object.keys(finished?.attributes ?? {}).filter((k) => k.startsWith("app.k")).length;
  return { kept, dropped: finished?.droppedAttributesCount ?? -1 };
}

describe("the span attribute count limit", () => {
  it("is 4096 by default, not OpenTelemetry's 128", async () => {
    vi.stubEnv("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", "");
    vi.stubEnv("OTEL_ATTRIBUTE_COUNT_LIMIT", "");
    expect(DEFAULT_SPAN_ATTRIBUTE_COUNT_LIMIT).toBe(4096);
    const { kept, dropped } = await keptOf(1000);
    expect(kept).toBe(1000);
    expect(dropped).toBe(0);
  });

  it("stops at 4096", async () => {
    vi.stubEnv("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", "");
    vi.stubEnv("OTEL_ATTRIBUTE_COUNT_LIMIT", "");
    const { kept } = await keptOf(5000);
    // The span's own keys (taxonomy and so on) count toward the limit too.
    expect(kept).toBeLessThanOrEqual(4096);
    expect(kept).toBeGreaterThan(4000);
  });

  it("lets OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT win", async () => {
    vi.stubEnv("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", "10");
    vi.stubEnv("OTEL_ATTRIBUTE_COUNT_LIMIT", "");
    const { kept, dropped } = await keptOf(50);
    expect(kept).toBeLessThanOrEqual(10);
    expect(dropped).toBeGreaterThanOrEqual(40);
  });

  it("lets OTEL_ATTRIBUTE_COUNT_LIMIT win", async () => {
    vi.stubEnv("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", "");
    vi.stubEnv("OTEL_ATTRIBUTE_COUNT_LIMIT", "20");
    const { kept, dropped } = await keptOf(50);
    expect(kept).toBeLessThanOrEqual(20);
    expect(dropped).toBeGreaterThanOrEqual(30);
  });

  it("keeps 4096 when the variable holds no number, which OpenTelemetry ignores", async () => {
    vi.stubEnv("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", "lots");
    vi.stubEnv("OTEL_ATTRIBUTE_COUNT_LIMIT", "  ");
    const { kept } = await keptOf(1000);
    expect(kept).toBe(1000);
  });
});
