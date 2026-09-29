/**
 * Another SDK's tracer provider holding the OpenTelemetry global (RIUS-1097).
 *
 * The OpenTelemetry global is write-once per process, so each test installs a
 * real second SDK through `register()` — the same call a Langfuse, Traceloop or
 * Logfire process makes — and lets `init()` find it there. Nothing is mocked:
 * the global is released again in `afterEach`, which is what `shutdown()` does
 * for the client anyway.
 */
import {
  type Context,
  ProxyTracerProvider,
  ROOT_CONTEXT,
  type Span,
  type TracerProvider,
  context,
  defaultTextMapGetter,
  propagation,
  trace,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { type Resource, resourceFromAttributes } from "@opentelemetry/resources";
import {
  AlwaysOnSampler,
  InMemorySpanExporter,
  type ReadableSpan,
  SamplingDecision,
  SimpleSpanProcessor,
  type SpanProcessor,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type InitOptions, type RiusClient, getTracer, init } from "../src/client.js";
import { resolveConfig } from "../src/config.js";
import { ForeignParentDetector, bridge, foreignGlobalProviderName } from "../src/foreign.js";
import {
  GEN_AI_AGENT_NAME,
  RIUS_PARENT_FOREIGN,
  RIUS_SDK_GLOBAL_PROVIDER,
  RIUS_SPAN_PENDING,
  SERVICE_INSTANCE_ID,
  SESSION_ID,
  USER_ID,
} from "../src/semconv.js";
import { withUser } from "../src/user.js";
import { withWorkspace } from "../src/workspace.js";

/** A stand-in for the other SDK, which also says what Rius attached to it. */
class ForeignProvider extends NodeTracerProvider {
  /** The provider's live processor list; Rius adds exactly one forwarder to it. */
  get attached(): SpanProcessor[] {
    const internals = this as unknown as {
      _activeSpanProcessor: { _spanProcessors: SpanProcessor[] };
    };
    return internals._activeSpanProcessor._spanProcessors;
  }
}

/** The other SDK's own processor: Rius must never shut it down or flush it. */
class LifecycleSpy implements SpanProcessor {
  shutdowns = 0;
  flushes = 0;
  onStart(): void {}
  onEnd(): void {}
  async shutdown(): Promise<void> {
    this.shutdowns += 1;
  }
  async forceFlush(): Promise<void> {
    this.flushes += 1;
  }
}

let client: RiusClient | undefined;
let foreign: ForeignProvider | undefined;

/** The client under test; the helpers below always leave one installed. */
function rius(): RiusClient {
  if (client === undefined) throw new Error("no client in this test");
  return client;
}

/** The other SDK's provider, installed by `installForeign()`. */
function other(): ForeignProvider {
  if (foreign === undefined) throw new Error("no foreign provider in this test");
  return foreign;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await client?.shutdown();
  await foreign?.shutdown();
  client = undefined;
  foreign = undefined;
  // `shutdown()` released them already when a client ran; a test that installs
  // only a foreign global must not leak it into the next one.
  trace.disable();
  context.disable();
  propagation.disable();
});

/** Install a second SDK as the process's tracer provider, before init(). */
function installForeign(resource?: Resource): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter();
  foreign = new ForeignProvider({
    ...(resource === undefined ? {} : { resource }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  foreign.register();
  return exporter;
}

function initRius(options: InitOptions = {}): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter();
  client = init({
    spanExporter: exporter,
    serviceName: "rius-svc",
    heartbeat: false,
    ...options,
  });
  return exporter;
}

function initBridged(options: InitOptions = {}): InMemorySpanExporter {
  return initRius({ bridgeForeignProvider: true, ...options });
}

/** The RIUS-1070 shape: an LLM span on Rius's provider inside another SDK's job span. */
function jobWithLlmChild(provider: TracerProvider, jobName = "job"): void {
  const job = provider.getTracer("customer.jobs").startSpan(jobName);
  context.with(trace.setSpan(context.active(), job), () => {
    getTracer().startSpan("llm").end();
  });
  job.end();
}

function byName(exporter: InMemorySpanExporter): Record<string, ReadableSpan> {
  return Object.fromEntries(exporter.getFinishedSpans().map((span) => [span.name, span]));
}

function names(exporter: InMemorySpanExporter): string[] {
  return exporter.getFinishedSpans().map((span) => span.name);
}

function flagged(exporter: InMemorySpanExporter): string[] {
  return exporter
    .getFinishedSpans()
    .filter((span) => span.attributes[RIUS_PARENT_FOREIGN] === true)
    .map((span) => span.name);
}

function attributesByName(
  exporter: InMemorySpanExporter,
): Record<string, ReadableSpan["attributes"]> {
  return Object.fromEntries(
    exporter.getFinishedSpans().map((span) => [span.name, { ...span.attributes }]),
  );
}

// --- the bridge ---------------------------------------------------------------

describe("the bridge", () => {
  it("exports the foreign parent so the trace is whole again", async () => {
    installForeign();
    const riusExporter = initBridged();
    jobWithLlmChild(other());
    await rius().flush();

    const spans = byName(riusExporter);
    expect(Object.keys(spans).sort()).toEqual(["job", "llm"]);
    expect(spans.llm.parentSpanContext?.spanId).toBe(spans.job.spanContext().spanId);
    expect(spans.job.parentSpanContext).toBeUndefined();
    expect(flagged(riusExporter)).toEqual([]);
  });

  it("leaves the foreign provider's own export alone", async () => {
    const theirs = installForeign();
    initBridged();
    jobWithLlmChild(other());
    await rius().flush();
    expect(names(theirs)).toEqual(["job"]);
  });

  it("exports bridged spans under the Rius resource identity, keeping foreign-only keys", async () => {
    installForeign(
      resourceFromAttributes({ "service.name": "langfuse-app", "deployment.environment": "x" }),
    );
    const riusExporter = initBridged({ agentName: "checkout-agent" });
    jobWithLlmChild(other());
    await rius().flush();

    const spans = byName(riusExporter);
    const job = spans.job.resource.attributes;
    const llm = spans.llm.resource.attributes;
    for (const key of [
      "service.name",
      SERVICE_INSTANCE_ID,
      GEN_AI_AGENT_NAME,
      RIUS_SDK_GLOBAL_PROVIDER,
    ]) {
      expect(job[key], key).toBe(llm[key]);
    }
    expect(job["service.name"]).toBe("rius-svc");
    expect(job[GEN_AI_AGENT_NAME]).toBe("checkout-agent");
    expect(job["deployment.environment"]).toBe("x");
    expect(llm["deployment.environment"]).toBeUndefined();
  });

  it("hands Rius's own spans their own resource object, unmerged", async () => {
    installForeign(resourceFromAttributes({ "deployment.environment": "x" }));
    const riusExporter = initBridged();
    getTracer().startSpan("own-a").end();
    getTracer().startSpan("own-b").end();
    await rius().flush();
    const spans = riusExporter.getFinishedSpans();
    expect(spans[0].resource).toBe(spans[1].resource);
    expect(spans[0].resource.attributes["deployment.environment"]).toBeUndefined();
  });

  it("is off by default: Rius keeps to its own provider and flags the orphan", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installForeign();
    const riusExporter = initRius();
    jobWithLlmChild(other());
    await rius().flush();

    expect(names(riusExporter)).toEqual(["llm"]);
    expect(flagged(riusExporter)).toEqual(["llm"]);
    expect(warn.mock.calls.flat().join("\n")).toContain("bridgeForeignProvider is off");
  });

  it("opts in from the environment, and explicit options still win", () => {
    expect(resolveConfig({}, {}).bridgeForeignProvider).toBe(false);
    expect(resolveConfig({}, { RIUS_BRIDGE_FOREIGN_PROVIDER: "true" }).bridgeForeignProvider).toBe(
      true,
    );
    expect(
      resolveConfig({ bridgeForeignProvider: false }, { RIUS_BRIDGE_FOREIGN_PROVIDER: "true" })
        .bridgeForeignProvider,
    ).toBe(false);
  });

  it("attaches exactly one processor to the other provider", () => {
    installForeign();
    const before = other().attached.length;
    initBridged();
    expect(other().attached.length).toBe(before + 1);
  });

  it("stops feeding the pipeline the moment it is released", () => {
    const seen: string[] = [];
    const pipeline: SpanProcessor = {
      onStart: (span) => seen.push(span.name),
      onEnd: () => {},
      forceFlush: async () => {},
      shutdown: async () => {},
    };
    const provider = new ForeignProvider({});
    const attached = bridge(provider, pipeline, new AlwaysOnSampler());
    if (attached === undefined) throw new Error("the provider took no processor");

    provider.getTracer("t").startSpan("before").end();
    attached.release();
    provider.getTracer("t").startSpan("after").end();

    expect(seen).toEqual(["before"]);
  });

  it("goes inert on shutdown without touching the other provider's processors", async () => {
    const theirs = installForeign();
    const spy = new LifecycleSpy();
    other().attached.push(spy);
    initBridged({ sessionId: "session-1" });
    await rius().shutdown();
    client = undefined;

    other().getTracer("customer.jobs").startSpan("after-shutdown").end();

    // A live pipeline would have stamped the session on the span it saw start.
    const [span] = theirs.getFinishedSpans();
    expect(span.name).toBe("after-shutdown");
    expect(span.attributes[SESSION_ID]).toBeUndefined();
    expect([spy.shutdowns, spy.flushes]).toEqual([0, 0]);
  });

  it("survives the other provider shutting itself down", async () => {
    installForeign();
    const riusExporter = initBridged();
    await other().shutdown();
    getTracer().startSpan("still-alive").end();
    await rius().flush();
    expect(names(riusExporter)).toEqual(["still-alive"]);
  });

  it("re-targets its one forwarder on re-init instead of stacking another", async () => {
    installForeign();
    initBridged();
    await rius().shutdown();
    const attachedAfterFirst = other().attached.length;

    // The second init() finds the SAME foreign provider still registered: only
    // the client's own global registration was released.
    other().register();
    const riusExporter = initBridged();
    jobWithLlmChild(other());
    await rius().flush();

    expect(other().attached.length).toBe(attachedAfterFirst);
    expect(names(riusExporter).sort()).toEqual(["job", "llm"]);
  });

  it("does not crash on a global that takes no span processor, and still detects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    class BareProvider {
      getTracer(): ReturnType<TracerProvider["getTracer"]> {
        return new ProxyTracerProvider().getTracer("noop");
      }
    }
    trace.setGlobalTracerProvider(new BareProvider() as TracerProvider);
    const riusExporter = initBridged();
    getTracer().startSpan("own").end();
    await rius().flush();

    expect(names(riusExporter)).toEqual(["own"]);
    expect(riusExporter.getFinishedSpans()[0].resource.attributes[RIUS_SDK_GLOBAL_PROVIDER]).toBe(
      "foreign:BareProvider",
    );
    expect(warn.mock.calls.flat().join("\n")).toContain("takes no additional span processor");
  });

  it("uses addSpanProcessor when the other provider offers one (OpenTelemetry JS 1.x)", () => {
    const added: SpanProcessor[] = [];
    class LegacyProvider {
      addSpanProcessor(processor: SpanProcessor): void {
        added.push(processor);
      }
      getTracer(): ReturnType<TracerProvider["getTracer"]> {
        return new ProxyTracerProvider().getTracer("legacy");
      }
    }
    trace.setGlobalTracerProvider(new LegacyProvider() as unknown as TracerProvider);
    initBridged();
    expect(added).toHaveLength(1);
  });
});

// --- the resource records the conflict ----------------------------------------

describe("the resource records the conflict", () => {
  it("names the foreign global provider", async () => {
    installForeign();
    const riusExporter = initRius();
    getTracer().startSpan("own").end();
    await rius().flush();
    expect(riusExporter.getFinishedSpans()[0].resource.attributes[RIUS_SDK_GLOBAL_PROVIDER]).toBe(
      "foreign:ForeignProvider",
    );
  });

  it("records nothing when Rius claims the global", async () => {
    const riusExporter = initRius();
    getTracer().startSpan("own").end();
    await rius().flush();
    const attributes = riusExporter.getFinishedSpans()[0].resource.attributes;
    expect(RIUS_SDK_GLOBAL_PROVIDER in attributes).toBe(false);
  });

  it("does not call an earlier Rius provider foreign", async () => {
    initRius();
    // The seam a re-init hits: the first client's provider is still the one
    // serving trace.getTracer(), and it is ours.
    expect(foreignGlobalProviderName()).toBeUndefined();
    await rius().shutdown();
    client = undefined;
    const riusExporter = initRius();
    getTracer().startSpan("own").end();
    await rius().flush();
    expect(RIUS_SDK_GLOBAL_PROVIDER in riusExporter.getFinishedSpans()[0].resource.attributes).toBe(
      false,
    );
  });
});

// --- detection ----------------------------------------------------------------

/** A parent from another PROCESS: ordinary distributed tracing, never a conflict. */
const REMOTE_TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

function remoteContext(): Context {
  return new W3CTraceContextPropagator().extract(
    ROOT_CONTEXT,
    { traceparent: REMOTE_TRACEPARENT },
    defaultTextMapGetter,
  );
}

describe("detection", () => {
  it("never flags a remote parent", async () => {
    installForeign();
    const riusExporter = initRius();
    getTracer().startSpan("server", undefined, remoteContext()).end();
    await rius().flush();

    const [span] = riusExporter.getFinishedSpans();
    expect(span.parentSpanContext?.isRemote).toBe(true);
    expect(flagged(riusExporter)).toEqual([]);
  });

  it("does not flag an own parent that has already ended", async () => {
    installForeign();
    const riusExporter = initRius();
    const parent = getTracer().startSpan("parent");
    parent.end();
    getTracer().startSpan("late-child", undefined, trace.setSpan(ROOT_CONTEXT, parent)).end();
    await rius().flush();
    expect(flagged(riusExporter)).toEqual([]);
  });

  it("flags only a local parent the pipeline never saw start", () => {
    const exporter = new InMemorySpanExporter();
    const detector = new ForeignParentDetector();
    const own = new NodeTracerProvider({
      spanProcessors: [detector, new SimpleSpanProcessor(exporter)],
    });
    // Nothing is registered here: the detector's answer must come from what its
    // own pipeline saw, not from who holds the global.
    const stranger = new NodeTracerProvider();
    const tracer = own.getTracer("t");

    const ownParent = tracer.startSpan("own-parent");
    tracer.startSpan("own-child", undefined, trace.setSpan(ROOT_CONTEXT, ownParent)).end();
    const strangerParent = stranger.getTracer("t").startSpan("foreign-parent");
    tracer.startSpan("foreign-child", undefined, trace.setSpan(ROOT_CONTEXT, strangerParent)).end();

    expect(flagged(exporter)).toEqual(["foreign-child"]);
    expect(detector.count).toBe(1);
  });

  it("does not flag a child of a bridged parent that has already ended", async () => {
    installForeign();
    const riusExporter = initBridged();
    const job = other().getTracer("customer.jobs").startSpan("job");
    job.end();
    // The pipeline saw the job span's TWIN, and its id is gone from the open
    // set the moment it ended, so only the twin lookup still answers for it.
    getTracer().startSpan("llm", undefined, trace.setSpan(ROOT_CONTEXT, job)).end();
    await rius().flush();

    expect(flagged(riusExporter)).toEqual([]);
  });

  it("does not flag a parent the context carries wrapped, as OpenInference does", async () => {
    installForeign();
    const riusExporter = initRius();
    const parent = getTracer().startSpan("parent");
    // OpenInference (which Rius's own instrumentations use) puts its OISpan
    // proxy in the context, not the span the pipeline started, so the child's
    // parent object fails an identity test although its parent is Rius's.
    const wrapped = new Proxy(parent, {}) as Span;
    getTracer().startSpan("child", undefined, trace.setSpan(ROOT_CONTEXT, wrapped)).end();
    parent.end();
    await rius().flush();

    expect(riusExporter.getFinishedSpans().map((s) => s.name)).toContain("child");
    expect(flagged(riusExporter)).toEqual([]);
  });

  it("still flags a wrapped parent that belongs to the other SDK", async () => {
    installForeign();
    const riusExporter = initRius();
    const foreignParent = other().getTracer("t").startSpan("foreign-parent");
    getTracer()
      .startSpan(
        "child",
        undefined,
        trace.setSpan(ROOT_CONTEXT, new Proxy(foreignParent, {}) as Span),
      )
      .end();
    await rius().flush();

    expect(flagged(riusExporter)).toEqual(["child"]);
  });

  it("detects the other SDK end to end, and says so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installForeign();
    const pings: Record<string, unknown>[] = [];
    const riusExporter = initRius({
      heartbeat: true,
      heartbeatTransport: async (payload) => {
        pings.push(payload);
      },
    });
    jobWithLlmChild(other());
    jobWithLlmChild(other());
    await rius().flush();
    // Read the export before shutdown: InMemorySpanExporter.shutdown() resets it.
    const exported = names(riusExporter);
    const orphans = flagged(riusExporter);
    const resource = riusExporter.getFinishedSpans()[0].resource;
    await rius().shutdown();
    client = undefined;

    expect(exported).toEqual(["llm", "llm"]);
    expect(orphans).toEqual(["llm", "llm"]);
    expect(pings[pings.length - 1]?.foreign_parent_spans).toBe(2);
    expect(pings[pings.length - 1]?.stopped).toBe(true);
    expect(resource.attributes[RIUS_SDK_GLOBAL_PROVIDER]).toBe("foreign:ForeignProvider");
    const warnings = warn.mock.calls
      .flat()
      .filter((line) => String(line).includes("owns the global tracer provider"));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0])).toContain("ForeignProvider");
    expect(String(warnings[0])).toContain("RIUS_BRIDGE_FOREIGN_PROVIDER=true");
  });

  it("counts nothing in the heartbeat when the bridge is on", async () => {
    installForeign();
    const pings: Record<string, unknown>[] = [];
    initBridged({
      heartbeat: true,
      heartbeatTransport: async (payload) => {
        pings.push(payload);
      },
    });
    jobWithLlmChild(other());
    await rius().shutdown();
    client = undefined;
    expect(pings[pings.length - 1]?.foreign_parent_spans).toBe(0);
  });

  it("gives bridged spans the same processing as its own", async () => {
    installForeign();
    const riusExporter = initBridged({ sessionId: "session-1" });
    jobWithLlmChild(other());
    await rius().flush();
    const sessions = new Set(
      riusExporter.getFinishedSpans().map((span) => span.attributes[SESSION_ID]),
    );
    expect([...sessions]).toEqual(["session-1"]);
  });

  it("feeds the new client from the earlier Rius global after a re-init", async () => {
    initBridged();
    await rius().shutdown();
    const riusExporter = initBridged();
    // The first client's provider still serves trace.getTracer(): third-party
    // code holding it must not fall silent for the second client.
    trace.getTracerProvider().getTracer("third.party").startSpan("global").end();
    await rius().flush();
    expect(names(riusExporter)).toEqual(["global"]);
  });
});

// --- content capture on bridged spans -----------------------------------------

/** What Langfuse 3.15 wrote on the bridged job span of the RIUS-1070 e2e. */
const LANGFUSE_JOB: Record<string, string | string[]> = {
  "langfuse.observation.type": "span",
  "langfuse.observation.input": '{"label": "job-0"}',
  "langfuse.observation.output": '{"answer": "96,450,000"}',
  "langfuse.observation.metadata.note": "customer payload",
  "langfuse.trace.name": "job-0",
  "langfuse.trace.input": '{"label": "job-0"}',
  "langfuse.trace.output": '{"answer": "96,450,000"}',
  "langfuse.trace.tags": ["run-1"],
  [SESSION_ID]: "run-1",
};

const LANGFUSE_CONTENT = [
  "langfuse.observation.input",
  "langfuse.observation.output",
  "langfuse.observation.metadata.note",
  "langfuse.trace.input",
  "langfuse.trace.output",
];

function langfuseIdentity(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(LANGFUSE_JOB).filter(([key]) => !LANGFUSE_CONTENT.includes(key)),
  );
}

async function bridgedLangfuseJob(
  options: InitOptions = {},
): Promise<Record<string, ReadableSpan>> {
  const riusExporter = initBridged(options);
  const job = other().getTracer("langfuse-sdk").startSpan("job");
  for (const [key, value] of Object.entries(LANGFUSE_JOB)) job.setAttribute(key, value);
  context.with(trace.setSpan(context.active(), job), () => {
    getTracer().startSpan("llm").end();
  });
  job.end();
  await rius().flush();
  return byName(riusExporter);
}

describe("content capture on bridged spans", () => {
  it("strips the other SDK's content keys when capture is off", async () => {
    installForeign();
    const attributes = (await bridgedLangfuseJob({ captureContent: false })).job.attributes;
    for (const key of LANGFUSE_CONTENT) expect(key in attributes, key).toBe(false);
    expect(
      Object.fromEntries(Object.entries(attributes).filter(([key]) => key in LANGFUSE_JOB)),
    ).toEqual(langfuseIdentity());
  });

  it("keeps them when capture is on", async () => {
    installForeign();
    const attributes = (await bridgedLangfuseJob()).job.attributes;
    expect(
      Object.fromEntries(Object.entries(attributes).filter(([key]) => key in LANGFUSE_JOB)),
    ).toEqual(LANGFUSE_JOB);
  });

  it("leaves the other SDK's own export untouched with capture off", async () => {
    const theirs = installForeign();
    await bridgedLangfuseJob({ captureContent: false });
    expect(attributesByName(theirs).job).toEqual(LANGFUSE_JOB);
  });

  it("masks a bridged span exactly as an own span", async () => {
    installForeign();
    const riusExporter = initBridged({ mask: (_value, ctx) => `masked:${ctx?.key}` });
    const tracers: [ReturnType<TracerProvider["getTracer"]>, string][] = [
      [other().getTracer("langfuse-sdk"), "bridged"],
      [getTracer(), "own"],
    ];
    for (const [tracer, name] of tracers) {
      const span = tracer.startSpan(name);
      for (const [key, value] of Object.entries(LANGFUSE_JOB)) span.setAttribute(key, value);
      span.end();
    }
    await rius().flush();

    const spans = attributesByName(riusExporter);
    expect(spans.bridged).toEqual(spans.own);
    expect(spans.own["langfuse.observation.input"]).toBe("masked:langfuse.observation.input");
  });
});

// --- Rius never writes to a span it did not create ------------------------------

/** Start attributes the normalizer maps onto canonical GenAI keys at span start. */
const OPENINFERENCE_LLM = {
  "openinference.span.kind": "LLM",
  "llm.provider": "openai",
  "llm.token_count.prompt": 3,
};

const CANONICAL_LLM = {
  "gen_ai.operation.name": "chat",
  "gen_ai.provider.name": "openai",
  "gen_ai.usage.input_tokens": 3,
};

/** The reviewer's probe, widened: user and workspace scopes, a GenAI child. */
function foreignWorkload(provider: TracerProvider): void {
  const tracer = provider.getTracer("langfuse-sdk");
  withUser("u-42", () => {
    withWorkspace("acme", () => {
      const job = tracer.startSpan("job", { attributes: { "langfuse.trace.name": "job" } });
      job.setAttribute("langfuse.observation.type", "span");
      context.with(trace.setSpan(context.active(), job), () => {
        tracer.startSpan("llm-call", { attributes: OPENINFERENCE_LLM }).end();
      });
      job.end();
    });
  });
}

/** A client stamping session, user, route and pendings; returns acme's exporter. */
function bridgeWithEveryStamp(): InMemorySpanExporter {
  const acme = new InMemorySpanExporter();
  initBridged({
    sessionId: "sess-123",
    workspaces: { acme: "key-acme" },
    workspaceExporterFactory: () => acme,
    partialSpans: true,
    partialSpansDelay: 0,
  });
  return acme;
}

function finals(exporter: InMemorySpanExporter): Record<string, ReadableSpan["attributes"]> {
  return Object.fromEntries(
    exporter
      .getFinishedSpans()
      .filter((span) => span.attributes[RIUS_SPAN_PENDING] === undefined)
      .map((span) => [span.name, span.attributes]),
  );
}

function pendings(exporter: InMemorySpanExporter): Record<string, ReadableSpan["attributes"]> {
  return Object.fromEntries(
    exporter
      .getFinishedSpans()
      .filter((span) => span.attributes[RIUS_SPAN_PENDING] === true)
      .map((span) => [span.name, span.attributes]),
  );
}

describe("Rius never writes to a span it did not create", () => {
  it("leaves the foreign export exactly what it is without Rius", async () => {
    const baseline = new InMemorySpanExporter();
    const baselineProvider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(baseline)],
    });
    foreignWorkload(baselineProvider);
    const withoutRius = attributesByName(baseline);
    await baselineProvider.shutdown();

    const theirs = installForeign();
    bridgeWithEveryStamp();
    foreignWorkload(other());
    await rius().flush();

    expect(attributesByName(theirs)).toEqual(withoutRius);
  });

  it("carries every stamp on the bridged spans in the Rius export", async () => {
    installForeign();
    const acme = bridgeWithEveryStamp();
    foreignWorkload(other());
    await rius().flush();

    const final = finals(acme);
    expect(Object.keys(final).sort()).toEqual(["job", "llm-call"]);
    for (const attributes of Object.values(final)) {
      expect([attributes[SESSION_ID], attributes[USER_ID]]).toEqual(["sess-123", "u-42"]);
    }
    expect(
      Object.fromEntries(Object.entries(final["llm-call"]).filter(([key]) => key in CANONICAL_LLM)),
    ).toEqual(CANONICAL_LLM);
  });

  it("carries them on the pending snapshots too", async () => {
    installForeign();
    const acme = bridgeWithEveryStamp();
    foreignWorkload(other());
    await rius().flush();

    const pending = pendings(acme);
    expect(Object.keys(pending).sort()).toEqual(["job", "llm-call"]);
    for (const attributes of Object.values(pending)) {
      expect([attributes[SESSION_ID], attributes[USER_ID]]).toEqual(["sess-123", "u-42"]);
    }
    expect(pending["llm-call"]["gen_ai.operation.name"]).toBe("chat");
  });

  it("exports a bridged span as it would an own one, and a later write still wins", async () => {
    installForeign();
    const riusExporter = initBridged({ sessionId: "sess-123" });
    const tracers: [ReturnType<TracerProvider["getTracer"]>, string][] = [
      [other().getTracer("x"), "bridged"],
      [getTracer(), "own"],
    ];
    for (const [tracer, name] of tracers) {
      withUser("u-42", () => {
        const span = tracer.startSpan(name, {
          attributes: { ...OPENINFERENCE_LLM, [SESSION_ID]: "x" },
        });
        // Written after start, so it wins over the start-time stamp.
        span.setAttribute(USER_ID, "set-later");
        span.end();
      });
    }
    await rius().flush();

    const spans = attributesByName(riusExporter);
    expect(spans.bridged).toEqual(spans.own);
    expect([spans.own[SESSION_ID], spans.own[USER_ID]]).toEqual(["sess-123", "set-later"]);
  });

  it("truncates its stamps on a bridged span as it does on an own one", async () => {
    vi.stubEnv("OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT", "8");
    installForeign();
    const riusExporter = initBridged({ sessionId: "session-longer-than-eight" });
    other().getTracer("x").startSpan("bridged").end();
    getTracer().startSpan("own").end();
    await rius().flush();

    const spans = attributesByName(riusExporter);
    expect(spans.bridged[SESSION_ID]).toBe("session-");
    expect(spans.own[SESSION_ID]).toBe("session-");
  });

  it("flags a bridged span only in the Rius export", async () => {
    const theirs = installForeign();
    const tracer = other().getTracer("customer.jobs");
    // Started before init(), so Rius's pipeline never saw this parent begin.
    const parent = tracer.startSpan("started-before-init");
    const riusExporter = initBridged();
    tracer.startSpan("child", undefined, trace.setSpan(ROOT_CONTEXT, parent)).end();
    parent.end();
    await rius().flush();

    expect(flagged(riusExporter)).toEqual(["child"]);
    expect(RIUS_PARENT_FOREIGN in attributesByName(theirs).child).toBe(false);
  });

  it("lets the workspace guard see the route of a bridged parent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installForeign();
    bridgeWithEveryStamp();
    withWorkspace("acme", () => {
      const job = other().getTracer("x").startSpan("job");
      context.with(trace.setSpan(context.active(), job), () => {
        withWorkspace("other-workspace", () => {
          getTracer().startSpan("llm").end();
        });
      });
      job.end();
    });
    await rius().flush();
    expect(warn.mock.calls.flat().join("\n")).toContain("cannot straddle two workspaces");
  });
});

// --- Rius's sampling decision holds for bridged spans ---------------------------

describe("sampling", () => {
  it("drops bridged spans and their own children, leaving the foreign export alone", async () => {
    const theirs = installForeign();
    const riusExporter = initBridged({ sampleRate: 0 });
    jobWithLlmChild(other());
    await rius().flush();

    expect(riusExporter.getFinishedSpans()).toEqual([]);
    expect(names(theirs)).toEqual(["job"]);
  });

  it("keeps or drops a trace whole by the Rius ratio", async () => {
    const theirs = installForeign();
    const riusExporter = initBridged({ sampleRate: 0.5 });
    const tracer = other().getTracer("customer.jobs");
    for (let run = 0; run < 64; run += 1) {
      const job = tracer.startSpan("job");
      context.with(trace.setSpan(context.active(), job), () => {
        const step = tracer.startSpan("step");
        context.with(trace.setSpan(context.active(), step), () => {
          getTracer().startSpan("llm").end();
        });
        step.end();
      });
      job.end();
    }
    await rius().flush();

    const ratio = new TraceIdRatioBasedSampler(0.5);
    const expected = new Set(
      theirs
        .getFinishedSpans()
        .filter(
          (span) =>
            ratio.shouldSample(ROOT_CONTEXT, span.spanContext().traceId).decision ===
            SamplingDecision.RECORD_AND_SAMPLED,
        )
        .map((span) => span.spanContext().traceId),
    );
    const namesByTrace = new Map<string, string[]>();
    for (const span of riusExporter.getFinishedSpans()) {
      const traceId = span.spanContext().traceId;
      namesByTrace.set(traceId, [...(namesByTrace.get(traceId) ?? []), span.name]);
    }
    expect(new Set(namesByTrace.keys())).toEqual(expected);
    for (const traceNames of namesByTrace.values()) {
      expect(traceNames.sort()).toEqual(["job", "llm", "step"]);
    }
    expect(expected.size).toBeGreaterThan(0);
    expect(expected.size).toBeLessThan(64);
  });

  it("keeps a bridged trace under a sampled remote parent, as it would an own one", async () => {
    installForeign();
    const riusExporter = initBridged({ sampleRate: 0 });
    const server = other()
      .getTracer("customer.jobs")
      .startSpan("server", undefined, remoteContext());
    context.with(trace.setSpan(context.active(), server), () => {
      getTracer().startSpan("llm").end();
    });
    server.end();
    await rius().flush();
    expect(names(riusExporter).sort()).toEqual(["llm", "server"]);
  });
});
