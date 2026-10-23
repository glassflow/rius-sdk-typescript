/**
 * `init({ setGlobal: false })`: a scoped client, as the Python SDK's
 * `init(set_global=False)` builds. It registers none of the OpenTelemetry
 * globals (tracer provider, context manager, propagator), neither takes nor
 * trips the one-global-client slot, leaves the SDK's own helpers on the global
 * client, never bridges another SDK's provider, releases nothing global on
 * shutdown, and enables only the integrations it names, never one a live
 * global client holds.
 */
import { context, propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredAgentName } from "../src/agent.js";
import { getTracer, type InitOptions, init, type RiusClient } from "../src/client.js";
import { globalTracerProvider } from "../src/foreign.js";
import { REGISTRY, type RegistryEntry } from "../src/instrumentation.js";
import { RIUS_SDK_GLOBAL_PROVIDER, SERVICE_NAME, TRACER_NAME } from "../src/semconv.js";

const clients: RiusClient[] = [];
let foreign: NodeTracerProvider | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0).reverse()) await client.shutdown().catch(() => {});
  await foreign?.shutdown();
  foreign = undefined;
  trace.disable();
  context.disable();
  propagation.disable();
});

function initTracked(options: InitOptions = {}): {
  client: RiusClient;
  exporter: InMemorySpanExporter;
} {
  const exporter = new InMemorySpanExporter();
  const client = init({ spanExporter: exporter, heartbeat: false, ...options });
  clients.push(client);
  return { client, exporter };
}

function scoped(options: InitOptions = {}) {
  return initTracked({ setGlobal: false, ...options });
}

/** Runs `body` with the registry holding exactly `entries`, then restores it. */
async function withRegistry(entries: RegistryEntry[], body: () => Promise<void>): Promise<void> {
  const saved = REGISTRY.splice(0, REGISTRY.length, ...entries);
  try {
    await body();
  } finally {
    REGISTRY.splice(0, REGISTRY.length, ...saved);
  }
}

function recordingEntry(name: string, log: string[]): RegistryEntry {
  return {
    name,
    kind: "self-applying",
    async load(_provider, teardown) {
      log.push(`load ${name}`);
      teardown?.push(() => log.push(`undo ${name}`));
      return true;
    },
  };
}

function spyOnWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("init({ setGlobal: false })", () => {
  it("registers none of the OpenTelemetry globals", () => {
    const { client } = scoped();
    expect(client).toBeDefined();
    expect(globalTracerProvider()).toBeUndefined();
    // Each global is write-once, so a registration that succeeds now proves
    // the scoped client took none of them.
    expect(trace.setGlobalTracerProvider(new NodeTracerProvider())).toBe(true);
    expect(context.setGlobalContextManager(new AsyncLocalStorageContextManager())).toBe(true);
    expect(propagation.setGlobalPropagator(new W3CTraceContextPropagator())).toBe(true);
  });

  it("exports the spans of its own tracer, under its own resource", async () => {
    const { client, exporter } = scoped({ serviceName: "scoped-svc" });
    client.getTracer().startSpan("op").end();
    await client.flush();
    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual(["op"]);
    expect(spans[0]?.resource.attributes[SERVICE_NAME]).toBe("scoped-svc");
  });

  it("names a tracer as the caller asks, defaulting to the SDK's scope", async () => {
    const { client, exporter } = scoped();
    client.getTracer().startSpan("own").end();
    client.getTracer("my-lib").startSpan("lib").end();
    await client.flush();
    const scopes = Object.fromEntries(
      exporter.getFinishedSpans().map((span) => [span.name, span.instrumentationScope.name]),
    );
    expect(scopes.own).toBe(TRACER_NAME);
    expect(scopes.lib).toBe("my-lib");
  });

  it("neither takes nor trips the one-global-client slot", () => {
    const first = scoped().client;
    const global = initTracked().client;
    expect(global).not.toBe(first);
    const second = scoped().client;
    expect(second).not.toBe(global);
    expect(second).not.toBe(first);
    // The slot is the global client's: a second global init() still returns it.
    const warn = spyOnWarn();
    expect(init({ spanExporter: new InMemorySpanExporter() })).toBe(global);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("leaves the SDK's own helpers on the global client", async () => {
    const global = initTracked({ agentName: "global-agent" });
    const local = scoped({ agentName: "scoped-agent" });
    getTracer().startSpan("helper").end();
    await global.client.flush();
    await local.client.flush();
    expect(global.exporter.getFinishedSpans().map((span) => span.name)).toEqual(["helper"]);
    expect(local.exporter.getFinishedSpans()).toEqual([]);
    expect(configuredAgentName()).toBe("global-agent");
  });

  it("releases nothing global when it shuts down", async () => {
    const global = initTracked();
    const local = scoped();
    await local.client.shutdown();
    // The global client's registration is intact: third-party code using the
    // OpenTelemetry API still reaches it.
    trace.getTracer("third-party").startSpan("after").end();
    await global.client.flush();
    expect(global.exporter.getFinishedSpans().map((span) => span.name)).toEqual(["after"]);
    expect(propagation.fields()).toContain("traceparent");
    expect(
      context.with(
        trace.setSpan(
          ROOT_CONTEXT,
          trace.wrapSpanContext({
            traceId: "0af7651916cd43dd8448eb211c80319c",
            spanId: "b7ad6b7169203331",
            traceFlags: 1,
          }),
        ),
        () => trace.getActiveSpan()?.spanContext().spanId,
      ),
    ).toBe("b7ad6b7169203331");
  });

  it("still heartbeats, since liveness is per client rather than global", async () => {
    const pings: unknown[] = [];
    const { client } = scoped({
      heartbeat: true,
      heartbeatTransport: async (payload) => {
        pings.push(payload);
      },
    });
    await client.shutdown();
    expect(pings.length).toBeGreaterThan(0);
  });

  it("warns and registers the globals when setGlobal is not a boolean", () => {
    const warn = spyOnWarn();
    const { client } = initTracked({ setGlobal: "false" as unknown as boolean });
    expect(warn.mock.calls.some((call) => String(call[0]).includes("setGlobal"))).toBe(true);
    expect(globalTracerProvider()).toBeDefined();
    expect(client).toBeDefined();
  });
});

describe("a scoped client next to another SDK's provider", () => {
  function installForeign(): InMemorySpanExporter {
    const exporter = new InMemorySpanExporter();
    foreign = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    foreign.register();
    return exporter;
  }

  it("records no conflict, warns nothing and bridges nothing", async () => {
    installForeign();
    const warn = spyOnWarn();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { client, exporter } = scoped({ bridgeForeignProvider: true });
    trace.getTracer("other-sdk").startSpan("foreign-op").end();
    client.getTracer().startSpan("own").end();
    await client.flush();
    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual(["own"]);
    expect(spans[0]?.resource.attributes[RIUS_SDK_GLOBAL_PROVIDER]).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("leaves the other SDK's globals in place when it shuts down", async () => {
    const otherExporter = installForeign();
    const { client } = scoped();
    await client.shutdown();
    expect(globalTracerProvider()).toBe(foreign);
    trace.getTracer("other-sdk").startSpan("still-there").end();
    expect(otherExporter.getFinishedSpans().map((span) => span.name)).toEqual(["still-there"]);
    expect(propagation.fields()).toContain("traceparent");
  });
});

describe("a scoped client's integrations", () => {
  it("enables none unless it names them", async () => {
    const log: string[] = [];
    await withRegistry([recordingEntry("alpha", log)], async () => {
      expect(await scoped().client.ready).toEqual([]);
      expect(log).toEqual([]);
    });
  });

  it("enables the ones it names", async () => {
    const log: string[] = [];
    await withRegistry([recordingEntry("alpha", log)], async () => {
      expect(await scoped({ instruments: ["alpha"] }).client.ready).toEqual(["alpha"]);
    });
  });

  it("leaves an integration with a live global client, with a warning", async () => {
    const log: string[] = [];
    await withRegistry([recordingEntry("alpha", log)], async () => {
      const global = initTracked();
      expect(await global.client.ready).toEqual(["alpha"]);
      const warn = spyOnWarn();
      const local = scoped({ instruments: ["alpha"] });
      expect(await local.client.ready).toEqual([]);
      expect(warn.mock.calls.some((call) => String(call[0]).includes("global"))).toBe(true);
      await local.client.shutdown();
      expect(log).toEqual(["load alpha"]);
    });
  });

  it("gives an integration up to a global client initialized after it", async () => {
    const log: string[] = [];
    await withRegistry([recordingEntry("alpha", log)], async () => {
      const local = scoped({ instruments: ["alpha"] });
      await local.client.ready;
      const global = initTracked();
      expect(await global.client.ready).toEqual(["alpha"]);
      expect(log).toEqual(["load alpha", "undo alpha", "load alpha"]);
    });
  });
});
