import { ROOT_CONTEXT, TraceFlags, context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type InitOptions, RiusClient, getTracer, init } from "../src/client.js";
import type { HeartbeatTransport } from "../src/heartbeat.js";
import { REGISTRY } from "../src/instrumentation.js";
import { GEN_AI_AGENT_NAME, RIUS_SPAN_PENDING, SERVICE_INSTANCE_ID } from "../src/semconv.js";
import { startAsCurrentSpan } from "../src/spans.js";

let client: RiusClient | undefined;

/**
 * A no-op heartbeat transport for tests whose purpose is unrelated to the
 * heartbeat: heartbeat defaults ON, so a real `init()` without this would hit
 * the network on every test run.
 */
const noopHeartbeatTransport: HeartbeatTransport = async () => {};

/** `init()` with the network-silencing heartbeat transport pre-applied. */
function testInit(options: InitOptions = {}): RiusClient {
  return init({ heartbeatTransport: noopHeartbeatTransport, ...options });
}

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
    client = testInit({ apiKey: "k", serviceName: "svc", spanExporter: exporter });
    getTracer().startSpan("s").end();
    await client.flush();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["s"]);
  });

  it("stamps the wire-visible scope name on every span", async () => {
    const exporter = new InMemorySpanExporter();
    client = testInit({ spanExporter: exporter });
    getTracer().startSpan("s").end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].instrumentationScope.name).toBe("rius");
  });

  it("stamps the service name on the resource", async () => {
    const exporter = new InMemorySpanExporter();
    client = testInit({ serviceName: "svc", spanExporter: exporter });
    getTracer().startSpan("s").end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].resource.attributes["service.name"]).toBe("svc");
  });

  it("stamps the agent name on the resource", async () => {
    const exporter = new InMemorySpanExporter();
    client = testInit({ serviceName: "svc", agentName: "planner", spanExporter: exporter });
    getTracer().startSpan("s").end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].resource.attributes[GEN_AI_AGENT_NAME]).toBe("planner");
  });

  it("falls back to the service name when no agent name is configured", async () => {
    const exporter = new InMemorySpanExporter();
    client = testInit({ serviceName: "svc", spanExporter: exporter });
    getTracer().startSpan("s").end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].resource.attributes[GEN_AI_AGENT_NAME]).toBe("svc");
  });

  it("groups spans and heartbeats under the same agent name when it differs from the service name", async () => {
    const payloads: Record<string, unknown>[] = [];
    const exporter = new InMemorySpanExporter();
    client = init({
      serviceName: "svc",
      agentName: "planner",
      spanExporter: exporter,
      heartbeatTransport: async (payload) => {
        payloads.push(payload);
      },
    });
    getTracer().startSpan("s").end();
    await client.flush();
    const resourceAgent = exporter.getFinishedSpans()[0].resource.attributes[GEN_AI_AGENT_NAME];
    expect(payloads.length).toBeGreaterThan(0);
    expect(payloads[0]?.agent_name).toBe(resourceAgent);
  });

  it("creates spans but exports nothing when disabled", async () => {
    const exporter = new InMemorySpanExporter();
    client = testInit({ disabled: true, spanExporter: exporter });
    getTracer().startSpan("s").end();
    await client.flush();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("returns the existing client and warns when called twice", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exporter = new InMemorySpanExporter();
    client = testInit({ spanExporter: exporter });
    expect(testInit({ spanExporter: new InMemorySpanExporter() })).toBe(client);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("allows a fresh init after shutdown", async () => {
    const first = testInit({ spanExporter: new InMemorySpanExporter() });
    await first.shutdown();

    const exporter = new InMemorySpanExporter();
    client = testInit({ spanExporter: exporter });
    expect(client).not.toBe(first);
    getTracer().startSpan("s").end();
    await client.flush();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["s"]);
  });

  it("strips content when captureContent is false", async () => {
    const exporter = new InMemorySpanExporter();
    client = testInit({ captureContent: false, spanExporter: exporter });
    const span = getTracer().startSpan("s");
    span.setAttribute("input.value", "secret");
    span.end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["input.value"]).toBeUndefined();
  });

  it("applies mask while still capturing content", async () => {
    const exporter = new InMemorySpanExporter();
    client = testInit({ mask: () => "[redacted]", spanExporter: exporter });
    const span = getTracer().startSpan("s");
    span.setAttribute("input.value", "secret");
    span.end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["input.value"]).toBe("[redacted]");
  });

  it("leaves content untouched when neither captureContent nor mask is set", async () => {
    const exporter = new InMemorySpanExporter();
    client = testInit({ spanExporter: exporter });
    const span = getTracer().startSpan("s");
    span.setAttribute("input.value", "secret");
    span.end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["input.value"]).toBe("secret");
  });

  it("drops a root span the ratio sampler rejects", async () => {
    const exporter = new InMemorySpanExporter();
    client = testInit({ sampleRate: 0, spanExporter: exporter });
    getTracer().startSpan("root").end();
    await client.flush();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("exports a child of a remote SAMPLED parent even at sampleRate 0", async () => {
    const exporter = new InMemorySpanExporter();
    client = testInit({ sampleRate: 0, spanExporter: exporter });

    startSpanUnderRemoteParent("child", TraceFlags.SAMPLED);

    await client.flush();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["child"]);
  });

  it("strips exception content from a recorded error when captureContent is false", async () => {
    const exporter = new InMemorySpanExporter();
    client = testInit({ captureContent: false, spanExporter: exporter });

    const leak = 'BadRequest 400: {"messages":[{"role":"user","content":"<PII>"}]}';
    await expect(
      startAsCurrentSpan("s", () => {
        throw new Error(leak);
      }),
    ).rejects.toThrow(leak);
    await client.flush();

    const span = exporter.getFinishedSpans()[0];
    const event = span.events[0];
    expect(event.name).toBe("exception");
    expect(event.attributes?.["exception.type"]).toBe("Error");
    expect(event.attributes?.["exception.message"]).toBeUndefined();
    expect(event.attributes?.["exception.stacktrace"]).toBeUndefined();

    // recordException() also copies the message onto the span's own status,
    // a separate carrier from the exception event above; captureContent:
    // false must scrub that too, or the same leak ships via status.message.
    expect(span.status.message).toBeUndefined();
  });

  it("keeps the exception message when captureContent is left at its default", async () => {
    const exporter = new InMemorySpanExporter();
    client = testInit({ mask: () => "[redacted]", spanExporter: exporter });

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
    client = testInit({ disabled: true, spanExporter: new InMemorySpanExporter() });
    await expect(client.ready).resolves.toEqual([]);
    for (const load of loads) expect(load).not.toHaveBeenCalled();
  });

  it("still registers the provider when disabled, so getTracer() keeps working", async () => {
    client = testInit({ disabled: true, spanExporter: new InMemorySpanExporter() });
    const span = getTracer().startSpan("s");
    expect(span.spanContext().traceId).not.toBe("00000000000000000000000000000000");
    span.end();
  });

  it("is not constructible outside init()", () => {
    // Compile-time assertion, enforced by `npm run typecheck`: a
    // caller-constructed client is not the global one, so its shutdown() would
    // skip trace.disable() and silently leave the SDK registered.
    //
    // The argument matters: `new RiusClient()` alone would also be flagged
    // by `@ts-expect-error` on pure arity grounds (RiusClient's constructor
    // takes one argument), which would stay green even if the constructor
    // became public. Passing an argument means the only remaining error is
    // "constructor is private".
    // @ts-expect-error the constructor is private; init() is the sole factory.
    expect(() => new RiusClient({} as never)).toBeTypeOf("function");
  });

  it("drops a child of a remote UNSAMPLED parent even at sampleRate 1", async () => {
    const exporter = new InMemorySpanExporter();
    client = testInit({ sampleRate: 1, spanExporter: exporter });

    startSpanUnderRemoteParent("child", TraceFlags.NONE);

    await client.flush();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("init: heartbeat", () => {
  it("pings immediately with the resolved agentName, on by default with no explicit option", () => {
    const transport = vi.fn<HeartbeatTransport>().mockResolvedValue(undefined);
    client = init({
      serviceName: "svc",
      spanExporter: new InMemorySpanExporter(),
      heartbeatTransport: transport,
    });

    expect(transport).toHaveBeenCalledTimes(1);
    const [payload] = transport.mock.calls[0] ?? [];
    expect((payload as { agent_name?: string }).agent_name).toBe("svc");
  });

  it("starts no heartbeat and never calls the transport when disabled", () => {
    const transport = vi.fn<HeartbeatTransport>().mockResolvedValue(undefined);
    client = init({
      disabled: true,
      spanExporter: new InMemorySpanExporter(),
      heartbeatTransport: transport,
    });

    expect(transport).not.toHaveBeenCalled();
  });

  it("sends stopped: true exactly once on shutdown(), and a second shutdown() doesn't re-ping", async () => {
    const transport = vi.fn<HeartbeatTransport>().mockResolvedValue(undefined);
    client = init({ spanExporter: new InMemorySpanExporter(), heartbeatTransport: transport });
    transport.mockClear();

    await client?.shutdown();
    expect(transport).toHaveBeenCalledTimes(1);
    expect((transport.mock.calls[0]?.[0] as { stopped?: boolean }).stopped).toBe(true);

    await client?.shutdown();
    expect(transport).toHaveBeenCalledTimes(1);
    client = undefined;
  });

  it("registers a beforeExit listener on init and removes it on shutdown", async () => {
    const before = process.listenerCount("beforeExit");
    client = init({
      spanExporter: new InMemorySpanExporter(),
      heartbeatTransport: noopHeartbeatTransport,
    });
    expect(process.listenerCount("beforeExit")).toBe(before + 1);

    await client?.shutdown();
    expect(process.listenerCount("beforeExit")).toBe(before);
    client = undefined;
  });
});

describe("init: partial spans", () => {
  it("emits pending and final span pairs when partialSpans is enabled", async () => {
    const exporter = new InMemorySpanExporter();
    client = testInit({ partialSpans: true, spanExporter: exporter });

    getTracer().startSpan("s").end();
    await client.flush();

    const spans = exporter.getFinishedSpans();
    const pending = spans.filter((s) => s.attributes[RIUS_SPAN_PENDING] === true);
    const final = spans.filter((s) => s.attributes[RIUS_SPAN_PENDING] !== true);
    expect(pending).toHaveLength(1);
    expect(final).toHaveLength(1);
    expect(pending[0].spanContext().spanId).toBe(final[0].spanContext().spanId);
  });

  it("emits no pending rows when partialSpans is left at its default (off)", async () => {
    const exporter = new InMemorySpanExporter();
    client = testInit({ spanExporter: exporter });

    getTracer().startSpan("s").end();
    await client.flush();

    const spans = exporter.getFinishedSpans();
    expect(spans.filter((s) => s.attributes[RIUS_SPAN_PENDING] === true)).toHaveLength(0);
  });

  it("starts no pending processor when disabled, so a span emits nothing", async () => {
    const exporter = new InMemorySpanExporter();
    client = testInit({ disabled: true, partialSpans: true, spanExporter: exporter });

    getTracer().startSpan("s").end();
    await client.flush();

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("instance identity (service.instance.id)", () => {
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it("stamps a uuid as service.instance.id on the resource of every span", async () => {
    const exporter = new InMemorySpanExporter();
    client = testInit({ serviceName: "svc", spanExporter: exporter });
    getTracer().startSpan("s").end();
    await client.flush();
    const id = exporter.getFinishedSpans()[0].resource.attributes[SERVICE_INSTANCE_ID];
    expect(id).toMatch(UUID_PATTERN);
  });

  it("sends the same id on heartbeat payloads and span resources", async () => {
    const payloads: Record<string, unknown>[] = [];
    const exporter = new InMemorySpanExporter();
    client = init({
      serviceName: "svc",
      spanExporter: exporter,
      heartbeatTransport: async (payload) => {
        payloads.push(payload);
      },
    });
    getTracer().startSpan("s").end();
    await client.flush();
    const resourceId = exporter.getFinishedSpans()[0].resource.attributes[SERVICE_INSTANCE_ID];
    expect(payloads.length).toBeGreaterThan(0);
    expect(payloads[0]?.instance_id).toBe(resourceId);
  });

  it("stamps the id even with the heartbeat disabled", async () => {
    const exporter = new InMemorySpanExporter();
    client = testInit({ serviceName: "svc", heartbeat: false, spanExporter: exporter });
    getTracer().startSpan("s").end();
    await client.flush();
    const id = exporter.getFinishedSpans()[0].resource.attributes[SERVICE_INSTANCE_ID];
    expect(id).toMatch(UUID_PATTERN);
  });

  it("gives two separately initialized clients distinct ids", async () => {
    const exporterA = new InMemorySpanExporter();
    client = testInit({ serviceName: "svc", spanExporter: exporterA });
    getTracer().startSpan("a").end();
    await client.flush();
    const idA = exporterA.getFinishedSpans()[0].resource.attributes[SERVICE_INSTANCE_ID];
    await client?.shutdown();

    const exporterB = new InMemorySpanExporter();
    client = testInit({ serviceName: "svc", spanExporter: exporterB });
    getTracer().startSpan("b").end();
    await client.flush();
    const idB = exporterB.getFinishedSpans()[0].resource.attributes[SERVICE_INSTANCE_ID];

    expect(idA).not.toBe(idB);
  });
});

describe("service.version on the resource", () => {
  /** The resource attributes of one span exported by `options`. */
  async function resourceAttributes(options: InitOptions): Promise<Record<string, unknown>> {
    const exporter = new InMemorySpanExporter();
    client = testInit({ spanExporter: exporter, ...options });
    await startAsCurrentSpan("s", () => {});
    await client.flush();
    return exporter.getFinishedSpans()[0].resource.attributes;
  }

  it("stamps the configured version", async () => {
    expect((await resourceAttributes({ serviceVersion: "1.2.3" }))["service.version"]).toBe(
      "1.2.3",
    );
  });

  it("leaves the key OFF the resource entirely when unset", async () => {
    // Not empty, not a placeholder: absent. `in` rather than a value check,
    // because resourceFromAttributes keeps an explicitly-undefined key.
    const attributes = await resourceAttributes({});
    expect("service.version" in attributes).toBe(false);
  });

  it("never stamps an empty version", async () => {
    const attributes = await resourceAttributes({ serviceVersion: "" });
    expect("service.version" in attributes).toBe(false);
  });

  it("reads RIUS_SERVICE_VERSION from the process environment", async () => {
    vi.stubEnv("RIUS_SERVICE_VERSION", "4.5.6");
    try {
      expect((await resourceAttributes({}))["service.version"]).toBe("4.5.6");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads service.version out of OTEL_RESOURCE_ATTRIBUTES, which the JS SDK would not", async () => {
    // NodeTracerProvider takes `options.resource ?? defaultResource()` and
    // resourceFromAttributes merges nothing, so the OTel env detector never
    // runs on this path — unlike Python, where Resource.create merges it.
    // config.ts reads the variable by hand to close that gap; without that,
    // this assertion would find the key missing.
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "service.version=7.8.9");
    try {
      expect((await resourceAttributes({}))["service.version"]).toBe("7.8.9");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("main-agent identity on the resource", () => {
  /** The resource attributes of one span exported by `options`. */
  async function resourceAttributes(options: InitOptions): Promise<Record<string, unknown>> {
    const exporter = new InMemorySpanExporter();
    client = testInit({ spanExporter: exporter, ...options });
    await startAsCurrentSpan("s", () => {});
    await client.flush();
    return exporter.getFinishedSpans()[0].resource.attributes;
  }

  it("stamps the configured agent name in the rius namespace", async () => {
    const attributes = await resourceAttributes({ agentName: "planner" });
    expect(attributes["rius.main_agent.name"]).toBe("planner");
  });

  it("STILL stamps gen_ai.agent.name: the move is additive, never a swap", async () => {
    // A swap would blank agent identity for every deployment sitting between
    // this SDK release and the sink release that reads the new key. If this
    // assertion is ever deleted, that promise is being broken.
    const attributes = await resourceAttributes({ agentName: "planner" });
    expect(attributes["gen_ai.agent.name"]).toBe("planner");
    expect(attributes["rius.main_agent.name"]).toBe(attributes["gen_ai.agent.name"]);
  });

  it("omits the main-agent name when the configured name is the placeholder", async () => {
    // Nothing was named. gen_ai.agent.name keeps carrying the placeholder as
    // it always has (the sink suppresses it on that leg); the new key simply
    // never claims an identity the caller did not give.
    const attributes = await resourceAttributes({});
    expect(attributes["gen_ai.agent.name"]).toBe("unknown_service");
    expect("rius.main_agent.name" in attributes).toBe(false);
  });

  it("leaves the id, description and version off the resource when unset", async () => {
    const attributes = await resourceAttributes({ agentName: "planner" });
    for (const key of [
      "rius.main_agent.id",
      "rius.main_agent.description",
      "rius.main_agent.version",
    ]) {
      expect(key in attributes, `${key} should be absent`).toBe(false);
    }
  });

  it("stamps the id, description and version verbatim when set", async () => {
    const attributes = await resourceAttributes({
      agentName: "planner",
      mainAgentId: "arn:aws:bedrock:eu-central-1:1:agent/ABC",
      mainAgentDescription: "plans multi-city trips",
      mainAgentVersion: "7",
    });
    expect(attributes["rius.main_agent.id"]).toBe("arn:aws:bedrock:eu-central-1:1:agent/ABC");
    expect(attributes["rius.main_agent.description"]).toBe("plans multi-city trips");
    expect(attributes["rius.main_agent.version"]).toBe("7");
  });

  it("reads RIUS_MAIN_AGENT_* from the process environment", async () => {
    vi.stubEnv("RIUS_MAIN_AGENT_ID", "env-agent");
    vi.stubEnv("RIUS_MAIN_AGENT_DESCRIPTION", "from the environment");
    vi.stubEnv("RIUS_MAIN_AGENT_VERSION", "2025-05-01");
    try {
      const attributes = await resourceAttributes({ agentName: "planner" });
      expect(attributes["rius.main_agent.id"]).toBe("env-agent");
      expect(attributes["rius.main_agent.description"]).toBe("from the environment");
      expect(attributes["rius.main_agent.version"]).toBe("2025-05-01");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("never derives the agent version from service.version, or the reverse", async () => {
    const onlyService = await resourceAttributes({ agentName: "a", serviceVersion: "2.3.1" });
    expect(onlyService["service.version"]).toBe("2.3.1");
    expect("rius.main_agent.version" in onlyService).toBe(false);

    await client?.shutdown();
    const onlyAgent = await resourceAttributes({ agentName: "a", mainAgentVersion: "7" });
    expect(onlyAgent["rius.main_agent.version"]).toBe("7");
    expect("service.version" in onlyAgent).toBe(false);
  });
});
