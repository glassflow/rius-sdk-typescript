import type { TracerProvider } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import { init } from "../src/client.js";
import { REGISTRY, enableInstrumentations } from "../src/instrumentation.js";

/** Structural stand-in: registerInstrumentations only ever calls getTracer(). */
const tracerProvider = { getTracer: () => undefined } as unknown as TracerProvider;

describe("REGISTRY", () => {
  it("declares both entry kinds, since Vercel ships a processor not an instrumentation", () => {
    const kinds = Object.fromEntries(REGISTRY.map((e) => [e.name, e.kind]));
    expect(kinds["vercel-ai"]).toBe("processor");
    expect(kinds.openai).toBe("instrumentation");
  });

  it("has unique names", () => {
    expect(new Set(REGISTRY.map((e) => e.name)).size).toBe(REGISTRY.length);
  });
});

describe("enableInstrumentations", () => {
  it("skips entries whose optional package is absent and never throws", async () => {
    const sink = { add: vi.fn() };
    const enabled = await enableInstrumentations(sink, tracerProvider, [
      "definitely-not-installed",
    ]);
    expect(enabled).toEqual([]);
    expect(sink.add).not.toHaveBeenCalled();
  });

  it("returns only the names it actually enabled", async () => {
    const sink = { add: vi.fn() };
    const enabled = await enableInstrumentations(sink, tracerProvider);
    for (const name of enabled) {
      expect(REGISTRY.map((e) => e.name)).toContain(name);
    }
  });

  it("does not throw when a registry entry's load() rejects, and omits it from the result", async () => {
    const sink = { add: vi.fn() };
    REGISTRY.push({
      name: "test-broken-entry",
      kind: "processor",
      load: () => Promise.reject(new Error("integration exploded")),
    });
    try {
      const enabled = await enableInstrumentations(sink, tracerProvider, ["test-broken-entry"]);
      expect(enabled).toEqual([]);
      expect(sink.add).not.toHaveBeenCalled();
    } finally {
      REGISTRY.splice(
        REGISTRY.findIndex((e) => e.name === "test-broken-entry"),
        1,
      );
    }
  });
});

describe("init().ready", () => {
  it("resolves with the enabled integration names and never rejects", async () => {
    const client = init({ spanExporter: new InMemorySpanExporter() });
    await expect(client.ready).resolves.toBeInstanceOf(Array);
    await client.shutdown();
  });

  it("resolves rather than rejects when no optional peer packages are installed", async () => {
    const client = init({ spanExporter: new InMemorySpanExporter() });
    // Settle explicitly: `await client.ready` inside expect() would let a
    // rejection surface as a test error that reads the same as a real failure,
    // and a bare resolves-assertion cannot prove which branch ran.
    const outcome = await client.ready.then(
      (names) => ({ settled: "resolved" as const, names }),
      (error: unknown) => ({ settled: "rejected" as const, error }),
    );
    expect(outcome.settled).toBe("resolved");
    expect(outcome.settled === "resolved" && Array.isArray(outcome.names)).toBe(true);
    await client.shutdown();
  });
});
