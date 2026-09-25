import { randomUUID } from "node:crypto";
import { type Tracer, context, propagation, trace } from "@opentelemetry/api";
// The -proto exporter (OTLP protobuf over HTTP), matching the Python SDK's
// opentelemetry-exporter-otlp-proto-http. The Rius ingest accepts only
// protobuf and refuses a JSON export with 415 Unsupported Media Type, so the
// -http (JSON) exporter cannot deliver a single span to it.
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  type SpanExporter,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { setConfiguredAgentName } from "./agent.js";
import { type RiusOptions, resolveConfig } from "./config.js";
import { DelegatingSpanProcessor } from "./delegatingProcessor.js";
import { ExportOutcomeExporter } from "./exportHealth.js";
import { HeartbeatSender, type HeartbeatTransport, OpenRootSpanTracker } from "./heartbeat.js";
import { enableInstrumentations } from "./instrumentation.js";
import { MaskingSpanExporter } from "./masking.js";
import { NormalizingSpanProcessor } from "./normalize.js";
import { PendingSpanProcessor } from "./pending.js";
import {
  GEN_AI_AGENT_NAME,
  RIUS_MAIN_AGENT_DESCRIPTION,
  RIUS_MAIN_AGENT_ID,
  RIUS_MAIN_AGENT_NAME,
  RIUS_MAIN_AGENT_VERSION,
  SERVICE_INSTANCE_ID,
  TRACER_NAME,
} from "./semconv.js";
import { SessionSpanProcessor } from "./session.js";
import { UserSpanProcessor } from "./user.js";
import { SDK_VERSION } from "./version.js";
import {
  RoutingSpanExporter,
  type WorkspaceExporterFactory,
  WorkspaceSpanProcessor,
  setGlobalRouting,
} from "./workspace.js";

/** Options accepted by {@link init}, extending the shared configuration. */
export interface InitOptions extends RiusOptions {
  /** Inject an exporter instead of OTLP. The test seam; prefer this to mocking. */
  spanExporter?: SpanExporter;
  /** Override the heartbeat HTTP transport. The test seam; prefer this to mocking fetch. */
  heartbeatTransport?: HeartbeatTransport;
  /**
   * Enable multi-workspace routing: a map of alias to API key. Spans started
   * inside `withWorkspace(alias, fn)` are exported with that workspace's
   * key; spans outside any scope use the default `apiKey`. Pass `{}` to opt
   * in with no static routes and register destinations later via
   * `registerWorkspace()`. One trace must stay inside one workspace.
   */
  workspaces?: Record<string, string>;
  /**
   * Override how per-workspace exporters are built from an API key. The
   * test seam, like `spanExporter`; defaults to the standard OTLP exporter
   * against the configured endpoint.
   */
  workspaceExporterFactory?: WorkspaceExporterFactory;
}

/**
 * Where each client's delegating processor lives. Deliberately not a class
 * field: a `private` field still appears in the emitted `.d.ts`, and there is
 * no `stripInternal`, so a module-scoped map is the only storage that keeps the
 * sink out of the published type surface entirely. Reached via
 * `spanProcessorSink()` below.
 */
const sinks = new WeakMap<RiusClient, DelegatingSpanProcessor>();

/**
 * The processor sink for a client, so later-resolving instrumentation can
 * contribute a span processor after the provider has been constructed.
 *
 * @internal Not re-exported from the package entry point; not public API.
 */
export function spanProcessorSink(client: RiusClient): DelegatingSpanProcessor {
  const sink = sinks.get(client);
  if (sink === undefined) throw new Error("[rius] client was not constructed by init()");
  return sink;
}

/**
 * Heartbeat internals for a client, kept off the class for the same reason as
 * `sinks` above: the sender and the `beforeExit` handler `shutdown()` must
 * reach are not public API, and a private class field would still put
 * `HeartbeatSender` into the emitted `.d.ts`.
 */
const heartbeats = new WeakMap<
  RiusClient,
  { sender: HeartbeatSender; beforeExitHandler: () => void }
>();

/** The internals `init()` hands to a new client. Never part of the public API. */
interface ClientParts {
  provider: NodeTracerProvider;
  processors: DelegatingSpanProcessor;
  health?: ExportOutcomeExporter;
  ready: Promise<string[]>;
  /** Disable functions for the instrumentations `ready` enabled; run on shutdown. */
  teardown: Array<() => void>;
  heartbeat?: { sender: HeartbeatSender; beforeExitHandler: () => void };
}

/**
 * The only way to construct a `RiusClient`, assigned by the static block in the
 * class below. `init()` is the sole public factory: a caller-built client is not
 * `globalClient`, so its `shutdown()` would skip `trace.disable()` and leave the
 * SDK registered. A `private constructor` alone cannot be reached from a
 * module-scoped function, and a static factory method would put the internal
 * types straight back into the published `.d.ts`.
 */
let createClient!: (parts: ClientParts) => RiusClient;

/**
 * Handle over a configured tracer pipeline, returned by {@link init}.
 * Exposes the lifecycle operations (`flush`, `shutdown`) and `ready`, which
 * resolves with the auto-instrumentations that attached.
 */
export class RiusClient {
  private readonly provider: NodeTracerProvider;
  private readonly health?: ExportOutcomeExporter;
  private readonly teardown: Array<() => void>;

  /** Resolves with the names of the auto-instrumentations that attached. */
  readonly ready: Promise<string[]>;

  private constructor(parts: ClientParts) {
    this.provider = parts.provider;
    this.health = parts.health;
    this.ready = parts.ready;
    this.teardown = parts.teardown;
    sinks.set(this, parts.processors);
    if (parts.heartbeat) heartbeats.set(this, parts.heartbeat);
  }

  static {
    createClient = (parts) => new RiusClient(parts);
  }

  /** Drains the queue. Resolves false if the most recent export failed. */
  async flush(): Promise<boolean> {
    await this.provider.forceFlush();
    return this.health?.lastExportFailed !== true;
  }

  /**
   * Drains and tears down the provider, then releases the global registration
   * so a later init() can reconfigure the SDK.
   *
   * The heartbeat's final `stopped: true` ping is sent before the provider
   * shuts down, so the backend hears "stopped" while the trace pipeline can
   * still export it. Idempotent: `sender.stop()` no-ops on a second call, and
   * the `beforeExit` listener is removed here so repeated init/shutdown
   * cycles never leak listeners.
   */
  async shutdown(): Promise<void> {
    const heartbeat = heartbeats.get(this);
    if (heartbeat) {
      process.removeListener("beforeExit", heartbeat.beforeExitHandler);
      await heartbeat.sender.stop();
    }
    // Instrumentations first, so a later init() re-patches against its own
    // provider instead of finding the double-patch guard already set. Waits
    // for `ready`, since the enabling may still be in flight; its rejections
    // were already turned into an empty list.
    await this.ready;
    for (const disable of this.teardown.splice(0)) {
      try {
        disable();
      } catch {
        // A patch that cannot be undone must not block the shutdown.
      }
    }
    try {
      await this.provider.shutdown();
    } finally {
      if (globalClient === this) {
        globalClient = undefined;
        setGlobalRouting(undefined);
        setConfiguredAgentName(undefined);
        // All three globals provider.register() claimed, not just the tracer:
        // leaving context and propagation registered makes the next init()'s
        // register() log duplicate-registration diag errors.
        trace.disable();
        context.disable();
        propagation.disable();
      }
    }
  }
}

let globalClient: RiusClient | undefined;

/**
 * The span attribute COUNT limit init() applies when the environment names
 * none.
 *
 * OpenTelemetry's default is 128, and OpenInference writes one attribute per
 * message field and per tool field: an agent loop with 10 tools passes 128
 * after about 9 turns. A full span does not fail loudly, it refuses every NEW
 * key, and the keys an instrumentor writes last are the usage, the output
 * messages, `output.value` and the finish reason, so cost and output vanish
 * from exactly the calls that matter most. 4096 holds a 20-turn, 10-tool agent
 * call several times over while still bounding a runaway span.
 *
 * The value-LENGTH limit is deliberately left at OpenTelemetry's default
 * (unlimited): truncating a message would corrupt its JSON.
 */
export const DEFAULT_SPAN_ATTRIBUTE_COUNT_LIMIT = 4096;

/** The variables OpenTelemetry reads for the span attribute count limit, most specific first. */
const ATTRIBUTE_COUNT_LIMIT_ENV = ["OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", "OTEL_ATTRIBUTE_COUNT_LIMIT"];

/**
 * Whether the environment sets the count limit in a way OpenTelemetry will
 * honour. OpenTelemetry JS resolves an explicit `spanLimits` in the provider
 * config BEFORE the environment, so the default above may only be passed when
 * neither variable is set; otherwise it would silently override the operator.
 * "Set" means what OpenTelemetry's own `getNumberFromEnv` accepts: non-blank
 * and a number. A blank or non-numeric value is ignored by OpenTelemetry (it
 * warns and falls back to 128), so it gets this SDK's default instead.
 */
function attributeCountLimitFromEnv(): boolean {
  return ATTRIBUTE_COUNT_LIMIT_ENV.some((name) => {
    const raw = process.env[name];
    return raw !== undefined && raw.trim() !== "" && !Number.isNaN(Number(raw));
  });
}

/**
 * Initialize the SDK: build a tracer pipeline that exports OTLP traces and
 * enable every bundled auto-instrumentation whose package is installed.
 *
 * Call it once, as early as possible in your process. A second call while a
 * client is active logs a warning and returns the existing client unchanged;
 * `shutdown()` releases the slot. `init()` is synchronous; await
 * {@link RiusClient.ready} if instrumentation must be attached before your
 * first span.
 *
 * The SDK installs no exit hook for SPANS: short-lived processes must call
 * {@link RiusClient.flush} before exiting or spans still in the batch queue
 * are lost. (The heartbeat does register a `beforeExit` listener, only to
 * send its final `stopped` ping; it flushes nothing.)
 */
export function init(options: InitOptions = {}): RiusClient {
  if (globalClient !== undefined) {
    console.warn(
      "[rius] init() called twice; returning the existing client. Call shutdown() first to reconfigure.",
    );
    return globalClient;
  }

  const config = resolveConfig(options);
  const processors = new DelegatingSpanProcessor();

  // Shared with the heartbeat sender below: both hit the same managed
  // endpoint under the same API key.
  const authHeaders: Record<string, string> = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : {};

  let health: ExportOutcomeExporter | undefined;
  let routing: RoutingSpanExporter | undefined;
  if (!config.disabled) {
    let base =
      options.spanExporter ??
      new OTLPTraceExporter({
        url: `${config.endpoint}/v1/traces`,
        headers: config.apiKey ? authHeaders : undefined,
      });
    if (options.workspaces !== undefined) {
      // Innermost in the chain, so masking and export-health wrap the whole
      // fan-out and apply to every destination alike.
      const factory =
        options.workspaceExporterFactory ??
        ((apiKey: string) =>
          new OTLPTraceExporter({
            url: `${config.endpoint}/v1/traces`,
            headers: { Authorization: `Bearer ${apiKey}` },
          }));
      routing = new RoutingSpanExporter(base, factory, options.workspaces);
      base = routing;
    }
    health = new ExportOutcomeExporter(base);
    // Masking is outermost so spans are sanitised before the health wrapper
    // hands them to OTLP.
    const exporter =
      !config.captureContent || config.mask !== undefined
        ? new MaskingSpanExporter(health, {
            captureContent: config.captureContent,
            mask: config.mask,
          })
        : health;
    const batch = new BatchSpanProcessor(exporter);
    // Added BEFORE the pending processor: both act at onStart, and the
    // pending snapshot is built from the attributes already on the span, so
    // the session id (and the workspace route, which decides which
    // destination the snapshot itself goes to) must be stamped first to
    // ride it.
    // FIRST of our own processors, at both hooks. At onEnd it must run before
    // the batch processor queues the span, so the canonical keys exist by the
    // time MaskingSpanExporter (which sits in the exporter chain, downstream of
    // the queue) decides what is content. At onStart it must run before the
    // pending processor snapshots the span, so the snapshot's canonical
    // identity allowlist matches. Always on; there is no opt-out.
    processors.add(new NormalizingSpanProcessor());
    processors.add(new SessionSpanProcessor(config.sessionId));
    processors.add(new UserSpanProcessor());
    if (routing !== undefined) {
      processors.add(new WorkspaceSpanProcessor());
    }
    if (config.partialSpans) {
      // Pending must see onStart/onEnd before the batch processor queues the
      // span for export, so it goes in ahead of it.
      processors.add(new PendingSpanProcessor(batch, { delayMs: config.partialSpansDelayMs }));
    }
    processors.add(batch);
  }

  // One identity per client lifetime, shared by spans (resource) and
  // heartbeats (payload instance_id) so the backend can join them and count
  // replicas. Workers spawned after init() (cluster/fork patterns) should
  // init() themselves for exact per-worker span identity.
  const instanceId = randomUUID();
  const provider = new NodeTracerProvider({
    // telemetry.sdk.* is reserved for the OTel SDK itself; we identify as a
    // distribution via telemetry.distro.*, the same two keys Python stamps.
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      [SERVICE_INSTANCE_ID]: instanceId,
      // The agent name the heartbeats already carry. Without it here, spans
      // fall back to service.name downstream while heartbeats group under the
      // agent name, so a process that configures the two differently sees its
      // agents view and its trace list disagree. Resolution defaults the agent
      // name to the service name, so nothing changes when they are the same.
      [GEN_AI_AGENT_NAME]: config.agentName,
      // The same fact in our own namespace, and the one the sink reads first.
      // `gen_ai.agent.name` above is kept ADDITIVELY and on purpose: it has no
      // resource-level meaning in the conventions and on a span it names the
      // agent being INVOKED, so it was one key answering two questions — but
      // dropping it here would be a flag day, blanking agent identity for
      // every deployment sitting between this SDK release and the sink
      // release. A resource rides once per OTLP batch, not once per span, so
      // carrying both costs essentially nothing.
      //
      // Spread like `service.version` below, for the same reason: a process
      // that named nothing resolves to the `unknown_service` placeholder, and
      // the main-agent name must then be ABSENT rather than claim an identity
      // the caller never gave — exactly what the span helpers already do.
      ...(config.mainAgentName === undefined
        ? {}
        : { [RIUS_MAIN_AGENT_NAME]: config.mainAgentName }),
      // Optional and never defaulted; see config.ts. `service.instance.id`
      // above is the process identity, these describe the AGENT the process
      // runs, which outlives any one process.
      ...(config.mainAgentId === undefined ? {} : { [RIUS_MAIN_AGENT_ID]: config.mainAgentId }),
      ...(config.mainAgentDescription === undefined
        ? {}
        : { [RIUS_MAIN_AGENT_DESCRIPTION]: config.mainAgentDescription }),
      // The version of the AGENT DEFINITION, never derived from (nor deriving)
      // `service.version` below: the build and the prompt/tools/policy it runs
      // move independently.
      ...(config.mainAgentVersion === undefined
        ? {}
        : { [RIUS_MAIN_AGENT_VERSION]: config.mainAgentVersion }),
      "telemetry.distro.name": "glassflow-rius",
      "telemetry.distro.version": SDK_VERSION,
      // Spread rather than assigned so an unresolved version leaves the key
      // OFF the resource entirely. `resourceFromAttributes` keeps an explicit
      // `undefined` as a raw attribute, and there is no placeholder to fall
      // back on by design: `service.name`'s `unknown_service` is the standing
      // argument against inventing one, since every unversioned process would
      // then claim the same fake version.
      ...(config.serviceVersion === undefined
        ? {}
        : { [ATTR_SERVICE_VERSION]: config.serviceVersion }),
    }),
    // Always ParentBased, with no AlwaysOn shortcut at rate 1. They are not
    // equivalent: ParentBased honours a remote UNSAMPLED parent and drops,
    // while AlwaysOn records regardless, producing children of a span the
    // upstream service dropped. Rate 1 is the default, so the shortcut would
    // have been the default path for every user.
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.sampleRate) }),
    // Only when the environment names no count limit: an explicit config
    // beats the environment in OpenTelemetry JS. See the constant.
    ...(attributeCountLimitFromEnv()
      ? {}
      : { spanLimits: { attributeCountLimit: DEFAULT_SPAN_ATTRIBUTE_COUNT_LIMIT } }),
    spanProcessors: [processors],
  });

  // Registry resolution is async. init() stays synchronous; callers who need
  // instrumentation attached before their first span await client.ready.
  //
  // Skipped entirely when disabled. Enabling an integration is not a private
  // act: it registers instrumentation hooks and monkey-patches third-party
  // prototypes in the caller's process. Someone who sets RIUS_DISABLED to take
  // this SDK out of the picture must be left with an unpatched process, so
  // `ready` resolves empty rather than advertising integrations that are not
  // recording anything.
  const teardown: Array<() => void> = [];
  const ready = config.disabled
    ? Promise.resolve<string[]>([])
    : enableInstrumentations(processors, provider, undefined, teardown);

  // Registered even when disabled: a provider whose only processor has no
  // delegates costs nothing, and it keeps getTracer() returning a real tracer,
  // so caller code that starts spans behaves the same either way and
  // shutdown() has a registration to release.
  provider.register();

  // Heartbeat: process-lifetime liveness, independent of trace traffic. The
  // tracker rides the delegating processor so payloads can carry the
  // currently-open root trace ids; disabled kills it too.
  let heartbeat: { sender: HeartbeatSender; beforeExitHandler: () => void } | undefined;
  // Without an API key the managed endpoint rejects every ping with 401, so
  // the default transport would only produce a warn-once and 15-second
  // failures. An injected transport (tests, own collectors) knows better.
  const heartbeatCanAuthenticate =
    config.apiKey !== undefined || options.heartbeatTransport !== undefined;
  if (config.heartbeat && !config.disabled && heartbeatCanAuthenticate) {
    const tracker = new OpenRootSpanTracker();
    processors.add(tracker);
    const sender = new HeartbeatSender({
      url: config.heartbeatEndpoint,
      headers: authHeaders,
      intervalMs: config.heartbeatIntervalMs,
      agentName: config.agentName,
      instanceId,
      tracker,
      transport: options.heartbeatTransport,
    });
    sender.start();
    // Best-effort: a process that exits without calling shutdown() should
    // still tell the backend it stopped. shutdown() removes this listener so
    // repeated init/shutdown cycles don't accumulate them.
    const beforeExitHandler = (): void => {
      void sender.stop();
    };
    process.once("beforeExit", beforeExitHandler);
    heartbeat = { sender, beforeExitHandler };
  }

  globalClient = createClient({ provider, processors, health, ready, teardown, heartbeat });
  setGlobalRouting(routing);
  // AGENT spans fall back to this when the caller names no agent.
  setConfiguredAgentName(config.agentName);
  return globalClient;
}

/** The SDK tracer. Scope name is wire-visible; do not parameterize it. */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME, SDK_VERSION);
}
