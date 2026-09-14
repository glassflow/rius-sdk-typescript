import type { Instrumentation } from "@opentelemetry/instrumentation";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { REGISTRY, type RegistryEntry } from "../src/instrumentation.js";

/**
 * init() -> shutdown() -> init() is documented as the way to reconfigure. The
 * OpenInference instrumentations guard against double patching, so on re-init
 * their patches stay bound to whatever tracer they were first enabled with:
 * unless shutdown() disables them, the second client records no provider
 * spans while `ready` still reports the integration.
 */

let client: RiusClient | undefined;

afterEach(async () => {
  await client?.shutdown();
  client = undefined;
});

/** An instrumentation that records the lifecycle calls registerInstrumentations makes. */
function fakeInstrumentation(calls: string[]): Instrumentation {
  return {
    instrumentationName: "fake",
    instrumentationVersion: "0",
    setTracerProvider: () => calls.push("bind"),
    setMeterProvider: () => {},
    setLoggerProvider: () => {},
    setConfig: () => {},
    getConfig: () => ({}),
    enable: () => calls.push("enable"),
    disable: () => calls.push("disable"),
  } as unknown as Instrumentation;
}

async function withEntry(entry: RegistryEntry, body: () => Promise<void>): Promise<void> {
  REGISTRY.push(entry);
  try {
    await body();
  } finally {
    REGISTRY.splice(
      REGISTRY.findIndex((e) => e.name === entry.name),
      1,
    );
  }
}

describe("shutdown() releases the instrumentations it enabled", () => {
  it("disables a registered instrumentation on shutdown and re-enables it on re-init", async () => {
    const calls: string[] = [];
    await withEntry(
      { name: "fake", kind: "instrumentation", load: async () => fakeInstrumentation(calls) },
      async () => {
        client = init({
          spanExporter: new InMemorySpanExporter(),
          heartbeatTransport: async () => {},
        });
        expect(await client.ready).toContain("fake");
        expect(calls).toEqual(["bind", "enable"]);

        await client.shutdown();
        expect(calls).toEqual(["bind", "enable", "disable"]);

        client = init({
          spanExporter: new InMemorySpanExporter(),
          heartbeatTransport: async () => {},
        });
        expect(await client.ready).toContain("fake");
        expect(calls).toEqual(["bind", "enable", "disable", "bind", "enable"]);
      },
    );
  });
});
