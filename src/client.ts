import { randomUUID } from "node:crypto";
import {
  context,
  diag,
  propagation,
  type Tracer,
  type TracerProvider,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  getNumberFromEnv,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
// The -proto exporter (OTLP protobuf over HTTP), matching the Python SDK's
// opentelemetry-exporter-otlp-proto-http. The Rius ingest accepts only
// protobuf and refuses a JSON export with 415 Unsupported Media Type, so the
// -http (JSON) exporter cannot deliver a single span to it.
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  type SpanExporter,
  type SpanLimits,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { setConfiguredAgentName } from "./agent.js";
import {
  CompactionFlagSpanProcessor,
  DEFAULT_SPAN_EVENT_COUNT_LIMIT,
  EVENT_COUNT_LIMIT_ENV,
} from "./compaction.js";
import {
  hasAuthorization,
  namedAgent,
  type OperatorMainAgent,
  type RiusOptions,
  resolveConfig,
  workspaceHeaders,
} from "./config.js";
import { CredentialHeaderDroppingExporter } from "./credentialHeaders.js";
import { DelegatingSpanProcessor } from "./delegatingProcessor.js";
import { ExportOutcomeExporter } from "./exportHealth.js";
import {
  type Bridge,
  BridgeAwareSampler,
  bridge,
  ForeignParentDetector,
  foreignGlobalProviderName,
  globalTracerProvider,
  ResourceAdoptingExporter,
  rememberOwnProvider,
} from "./foreign.js";
import { HeartbeatSender, type HeartbeatTransport, OpenRootSpanTracker } from "./heartbeat.js";
import { enableInstrumentations, type InstrumentModules } from "./instrumentation.js";
import { MaskingSpanExporter } from "./masking.js";
import { NativeProviderSpanDemoter } from "./nativeProviderSpans.js";
import { NormalizingSpanProcessor } from "./normalize.js";
import { PendingSpanProcessor } from "./pending.js";
import {
  GEN_AI_AGENT_NAME,
  GEN_AI_MAIN_AGENT_DESCRIPTION,
  GEN_AI_MAIN_AGENT_ID,
  GEN_AI_MAIN_AGENT_NAME,
  RIUS_MAIN_AGENT_DESCRIPTION,
  RIUS_MAIN_AGENT_ID,
  RIUS_MAIN_AGENT_NAME,
  RIUS_MAIN_AGENT_VERSION,
  RIUS_SDK_GLOBAL_PROVIDER,
  SERVICE_INSTANCE_ID,
  SERVICE_NAME,
  SERVICE_VERSION,
  TELEMETRY_DISTRO_NAME,
  TELEMETRY_DISTRO_VERSION,
  TRACER_NAME,
} from "./semconv.js";
import { SessionSpanProcessor } from "./session.js";
import { UserSpanProcessor } from "./user.js";
import { SDK_VERSION } from "./version.js";
import {
  RoutingSpanExporter,
  setGlobalRouting,
  type WorkspaceExporterFactory,
  WorkspaceSpanProcessor,
} from "./workspace.js";

/** Options accepted by {@link init}, extending the shared configuration. */
export interface InitOptions extends RiusOptions {
  /** Inject an exporter instead of OTLP. The test seam; prefer this to mocking. */
  spanExporter?: SpanExporter;
  /** Override the heartbeat HTTP transport. The test seam; prefer this to mocking fetch. */
  heartbeatTransport?: HeartbeatTransport;
  /**
   * Modules your app imported itself, for the `anthropic` and `openai`
   * integrations: `{ anthropic: { instrumentation, sdk } }`, each field an
   * `import * as` namespace of `@arizeai/openinference-instrumentation-anthropic`
   * and `@anthropic-ai/sdk` (or their `openai` counterparts). An integration
   * given here is enabled from these modules and nothing is resolved for it.
   * For deployments where the SDK cannot load its optional peers itself, such
   * as a pnpm app on a file-tracing host. The `sdk` must be the copy your own
   * client calls use. A module of the wrong shape logs one warning and leaves
   * that integration off.
   */
  instrumentModules?: InstrumentModules;
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
 * The processor sink for a client, so a span processor can be added after the
 * provider has been constructed.
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

/**
 * The handle on Rius's pipeline riding another SDK's tracer provider, kept off
 * the class for the same reason as `sinks` and `heartbeats` above. Present only
 * when another provider held the OpenTelemetry global and bridging was enabled.
 */
const bridges = new WeakMap<RiusClient, Bridge>();

/** The internals `init()` hands to a new client. Never part of the public API. */
interface ClientParts {
  provider: NodeTracerProvider;
  processors: DelegatingSpanProcessor;
  health?: ExportOutcomeExporter;
  ready: Promise<string[]>;
  /** Disable functions for the instrumentations `ready` enabled; run on shutdown. */
  teardown: Array<() => void>;
  heartbeat?: { sender: HeartbeatSender; beforeExitHandler: () => void };
  bridge?: Bridge;
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
    if (parts.bridge) bridges.set(this, parts.bridge);
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
    // Before the provider shuts down, so the other SDK's spans stop entering a
    // pipeline that is about to go away. Its own processors are never touched:
    // OTel offers no way to remove one, so the forwarder is only made inert.
    bridges.get(this)?.release();
    try {
      await this.provider.shutdown();
    } finally {
      if (globalClient === this) {
        globalClient = undefined;
        ownTracerProvider = undefined;
        setGlobalRouting(undefined);
        setConfiguredAgentName(undefined);
        releaseGlobals(ownGlobals);
        ownGlobals = undefined;
      }
    }
  }
}

let globalClient: RiusClient | undefined;

/** Which OpenTelemetry globals init() registered, so shutdown() releases only those. */
interface OwnGlobals {
  trace: boolean;
  context: boolean;
  propagation: boolean;
}

let ownGlobals: OwnGlobals | undefined;

/**
 * Register `provider` and the defaults `NodeTracerProvider.register()` would
 * install (an AsyncLocalStorage context manager, W3C trace context and
 * baggage propagation), recording which of the three this call won.
 *
 * Done by hand rather than through `register()` because each global is
 * write-once and `register()` does not say which ones it took: another SDK
 * may already hold any of them, and shutdown() must leave that SDK's globals
 * exactly as they were. Disabling a global Rius did not register would
 * unregister the other SDK's tracer, the context manager that parents its
 * spans, and its propagator.
 */
function registerGlobals(provider: TracerProvider): OwnGlobals {
  const won: OwnGlobals = {
    trace: trace.setGlobalTracerProvider(provider),
    context: false,
    propagation: false,
  };
  const contextManager = new AsyncLocalStorageContextManager().enable();
  won.context = context.setGlobalContextManager(contextManager);
  if (!won.context) contextManager.disable();
  won.propagation = propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  );
  return won;
}

/**
 * Release the globals {@link registerGlobals} won. All three, not just the
 * tracer: leaving our context manager or propagator registered makes the next
 * init() log duplicate-registration diag errors.
 */
function releaseGlobals(won: OwnGlobals | undefined): void {
  if (won?.trace) trace.disable();
  if (won?.context) context.disable();
  if (won?.propagation) propagation.disable();
}

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

/** The variables OpenTelemetry reads for the span attribute value length limit. */
const ATTRIBUTE_VALUE_LENGTH_LIMIT_ENV = [
  "OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT",
  "OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT",
];

/**
 * The main-agent resource attributes, each only when known: the deprecated
 * `rius.main_agent.{name,id,description}` (kept through their window so a sink
 * that reads only the old keys keeps the agent's identity), plus the
 * conventions' `gen_ai.main_agent.*` entity, whose rule lives in
 * {@link upstreamMainAgentAttributes}. `rius.main_agent.version` has no
 * upstream twin and is stamped separately.
 */
function mainAgentAttributes(config: {
  mainAgentName?: string;
  mainAgentId?: string;
  mainAgentDescription?: string;
  operatorMainAgent: OperatorMainAgent;
}): Record<string, string> {
  const rius: Record<string, string> = {};
  if (config.mainAgentName !== undefined) rius[RIUS_MAIN_AGENT_NAME] = config.mainAgentName;
  if (config.mainAgentId !== undefined) rius[RIUS_MAIN_AGENT_ID] = config.mainAgentId;
  if (config.mainAgentDescription !== undefined) {
    rius[RIUS_MAIN_AGENT_DESCRIPTION] = config.mainAgentDescription;
  }
  return {
    ...rius,
    ...upstreamMainAgentAttributes({
      name: config.mainAgentName,
      configuredId: config.mainAgentId,
      description: config.mainAgentDescription,
      operator: config.operatorMainAgent,
    }),
  };
}

/** Once per process: the hint is advice about configuration, not news. */
let derivedMainAgentIdHinted = false;

/** `value`, unless it is unset, empty or only whitespace. */
function usable(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

/**
 * The conventions' `gen_ai.main_agent` entity: id, name, description.
 *
 * The ONE place the rule for emitting it lives. The conventions make
 * `gen_ai.main_agent.id` the entity's identity and say the entity MUST NOT be
 * emitted without a stable one. So the id is, in order: the configured
 * `mainAgentId` (the option, then `RIUS_MAIN_AGENT_ID`), then a
 * `gen_ai.main_agent.id` the operator already put on the resource (`operator`,
 * from `OTEL_RESOURCE_ATTRIBUTES`), then the resolved agent name, as is: it is
 * stable across restarts and readable, but renaming the agent changes it. An
 * empty or whitespace-only value counts as unset. With none of them (and the
 * name empty or the `unknown_service` placeholder) no `gen_ai.main_agent.*` key
 * is emitted from the SDK's settings. The SDK's name and description ride only
 * with the id; an operator-set one is the operator's own and passed through.
 *
 * An operator-set id counts as configured, so it logs no hint. An operator-set
 * name or description is never overwritten.
 *
 * `rius.main_agent.id` is NOT derived, nor taken from the operator's value: it
 * stays the configured id only.
 *
 * The hint goes to OpenTelemetry's diag logger at debug level, so it is silent
 * unless the app installs one (`diag.setLogger(..., DiagLogLevel.DEBUG)`).
 *
 * Exported for tests; not part of the public API (not re-exported by index).
 */
export function upstreamMainAgentAttributes(main: {
  name?: string;
  configuredId?: string;
  description?: string;
  operator?: OperatorMainAgent;
}): Record<string, string> {
  const operator = main.operator ?? {};
  const named = usable(namedAgent(main.name));
  const configured = usable(main.configuredId) ?? usable(operator.id);
  const entityId = configured ?? named;
  const attributes: Record<string, string> = {};
  if (entityId) {
    if (!configured && !derivedMainAgentIdHinted) {
      derivedMainAgentIdHinted = true;
      diag.debug(
        `[rius] gen_ai.main_agent.id is the agent name "${named}" because no mainAgentId is set; set mainAgentId (RIUS_MAIN_AGENT_ID) to a stable identifier so renaming the agent does not change it.`,
      );
    }
    attributes[GEN_AI_MAIN_AGENT_ID] = entityId;
    if (named !== undefined) attributes[GEN_AI_MAIN_AGENT_NAME] = named;
    if (main.description) attributes[GEN_AI_MAIN_AGENT_DESCRIPTION] = main.description;
  }
  // The operator's own name and description stand, as they would on any
  // resource the OTel SDK merges them into.
  if (usable(operator.name)) attributes[GEN_AI_MAIN_AGENT_NAME] = operator.name as string;
  if (usable(operator.description)) {
    attributes[GEN_AI_MAIN_AGENT_DESCRIPTION] = operator.description as string;
  }
  return attributes;
}

/**
 * The limits this SDK applies, resolved the way OpenTelemetry resolves them.
 *
 * An explicit `spanLimits` in the provider config wins over the environment in
 * OpenTelemetry JS, so passing one would silently override the operator unless
 * the environment is consulted here first, in OpenTelemetry's own order and
 * with its own parser (a blank or non-numeric value is ignored). The result is
 * resolved once and shared with the bridge, which gives a bridged span's twin
 * the same limits an own span gets: a foreign span cannot stamp more
 * attributes, or longer ones, than Rius would have allowed on its own.
 */
function resolveSpanLimits(): SpanLimits {
  const fromEnv = (names: string[]): number | undefined => {
    for (const name of names) {
      const value = getNumberFromEnv(name);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  return {
    attributeCountLimit: fromEnv(ATTRIBUTE_COUNT_LIMIT_ENV) ?? DEFAULT_SPAN_ATTRIBUTE_COUNT_LIMIT,
    attributeValueLengthLimit:
      fromEnv(ATTRIBUTE_VALUE_LENGTH_LIMIT_ENV) ?? Number.POSITIVE_INFINITY,
    // Resolved here so the provider and the normalizer, which adds events to
    // an ended span, enforce one number.
    eventCountLimit: fromEnv([EVENT_COUNT_LIMIT_ENV]) ?? DEFAULT_SPAN_EVENT_COUNT_LIMIT,
  };
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
  const spanLimits = resolveSpanLimits();

  // Read before anything is registered: the OpenTelemetry global is write-once,
  // so whichever provider already holds it keeps it, and the resource below —
  // immutable once built — is the only place that conflict can be recorded.
  const foreignGlobal = foreignGlobalProviderName();

  // One identity per client lifetime, shared by spans (resource) and
  // heartbeats (payload instance_id) so the backend can join them and count
  // replicas. Workers spawned after init() (cluster/fork patterns) should
  // init() themselves for exact per-worker span identity.
  const instanceId = randomUUID();

  // telemetry.sdk.* is reserved for the OTel SDK itself, so it comes from
  // OpenTelemetry's own default resource (language, name, version), as the
  // Python SDK's Resource.create adds it; a resource handed to the provider is
  // used as given, so the defaults have to be merged in here. We identify as a
  // distribution via telemetry.distro.*, the same two keys Python stamps. Our
  // attributes are the update in the merge, so service.name replaces the
  // default `unknown_service:<process>`.
  const riusAttributes = resourceFromAttributes({
    [SERVICE_NAME]: config.serviceName,
    [SERVICE_INSTANCE_ID]: instanceId,
    // The agent name the heartbeats already carry. Without it here, spans
    // fall back to service.name downstream while heartbeats group under the
    // agent name, so a process that configures the two differently sees its
    // agents view and its trace list disagree. Resolution defaults the agent
    // name to the service name, so nothing changes when they are the same.
    // Spread, and absent on the `unknown_service` placeholder, by the same
    // rule as the main-agent keys below: a process that named nothing claims
    // no agent identity.
    ...(config.mainAgentName === undefined ? {} : { [GEN_AI_AGENT_NAME]: config.mainAgentName }),
    // The same fact under the conventions' main-agent keys (and, through its
    // deprecation window, `rius.main_agent.name`), which the sink reads first.
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
    //
    // The rius id and description are optional and never defaulted; the
    // conventions' id falls back to the agent name (see
    // upstreamMainAgentAttributes and config.ts).
    // `service.instance.id` above is the process identity, these describe the
    // AGENT the process runs, which outlives any one process.
    ...mainAgentAttributes(config),
    // The version of the AGENT DEFINITION, never derived from (nor deriving)
    // `service.version` below: the build and the prompt/tools/policy it runs
    // move independently.
    ...(config.mainAgentVersion === undefined
      ? {}
      : { [RIUS_MAIN_AGENT_VERSION]: config.mainAgentVersion }),
    // `foreign:<Class>` when another SDK already held the OpenTelemetry global
    // at init(); absent when Rius registered it. Spread, because the ABSENCE of
    // the key is what says "Rius owns the global here" — a placeholder value
    // would make every ordinary process look like a resolved conflict.
    ...(foreignGlobal === undefined
      ? {}
      : { [RIUS_SDK_GLOBAL_PROVIDER]: `foreign:${foreignGlobal}` }),
    [TELEMETRY_DISTRO_NAME]: "glassflow-rius",
    [TELEMETRY_DISTRO_VERSION]: SDK_VERSION,
    // Spread rather than assigned so an unresolved version leaves the key
    // OFF the resource entirely. `resourceFromAttributes` keeps an explicit
    // `undefined` as a raw attribute, and there is no placeholder to fall
    // back on by design: `service.name`'s `unknown_service` is the standing
    // argument against inventing one, since every unversioned process would
    // then claim the same fake version.
    ...(config.serviceVersion === undefined ? {} : { [SERVICE_VERSION]: config.serviceVersion }),
  });
  // OTEL_RESOURCE_ATTRIBUTES sits between the two, as Python's
  // Resource.create merges it: every key it carries reaches the resource
  // (deployment.environment.name, cloud.region, ...), and the SDK's own keys
  // win over it.
  const resource = defaultResource()
    .merge(resourceFromAttributes(config.otelResourceAttributes))
    .merge(riusAttributes);

  let health: ExportOutcomeExporter | undefined;
  let routing: RoutingSpanExporter | undefined;
  let detector: ForeignParentDetector | undefined;
  // Enabled with the OpenInference Anthropic instrumentation, below.
  const demoter = new NativeProviderSpanDemoter();
  if (!config.disabled) {
    let base =
      options.spanExporter ??
      new OTLPTraceExporter({
        url: `${config.endpoint}/v1/traces`,
        headers: Object.keys(config.headers).length > 0 ? config.headers : undefined,
      });
    if (options.workspaces !== undefined) {
      // Innermost in the chain, so masking and export-health wrap the whole
      // fan-out and apply to every destination alike.
      const factory =
        options.workspaceExporterFactory ??
        ((apiKey: string) =>
          new OTLPTraceExporter({
            url: `${config.endpoint}/v1/traces`,
            headers: workspaceHeaders(config.headers, apiKey),
          }));
      routing = new RoutingSpanExporter(base, factory, options.workspaces);
      base = routing;
    }
    health = new ExportOutcomeExporter(base);
    // Masking is outermost so spans are sanitised before the health wrapper
    // hands them to OTLP. Credential headers are dropped whatever the
    // content settings say, so that wrapper is always there.
    const credentials = new CredentialHeaderDroppingExporter(health);
    const exporter =
      !config.captureContent || config.mask !== undefined
        ? new MaskingSpanExporter(credentials, {
            captureContent: config.captureContent,
            mask: config.mask,
          })
        : credentials;
    // Outermost: a bridged span arrives carrying the OTHER provider's resource,
    // from which the sink can derive neither the agent name nor the instance
    // id. Rius's own spans already hold `resource` and pass through untouched.
    const adopting = new ResourceAdoptingExporter(exporter, resource);
    const batch = new BatchSpanProcessor(adopting);
    // Ahead of every other processor: it reads the parent span out of the start
    // context, which no later processor changes, and its flag must be on the
    // span before the pending snapshot is built from it.
    detector = new ForeignParentDetector(foreignGlobal);
    processors.add(detector);
    // The first of our own processors, ahead of normalization at both hooks:
    // a demoted span must not have its LLM kind derived from the operation it
    // is about to lose, and the pending snapshot must not see it either. It
    // only ever deletes keys, so normalization still sees every key it fills.
    processors.add(demoter);
    // Added BEFORE the pending processor: both act at onStart, and the
    // pending snapshot is built from the attributes already on the span, so
    // the session id (and the workspace route, which decides which
    // destination the snapshot itself goes to) must be stamped first to
    // ride it.
    // Normalization comes next, at both hooks. At onEnd it must run before
    // the batch processor queues the span, so the canonical keys exist by the
    // time MaskingSpanExporter (which sits in the exporter chain, downstream of
    // the queue) decides what is content. At onStart it must run before the
    // pending processor snapshots the span, so the snapshot's canonical
    // identity allowlist matches. Always on; there is no opt-out.
    processors.add(new NormalizingSpanProcessor(undefined, spanLimits.eventCountLimit));
    processors.add(new SessionSpanProcessor(config.sessionId));
    processors.add(new UserSpanProcessor());
    processors.add(new CompactionFlagSpanProcessor());
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

  const sampler = new BridgeAwareSampler(
    new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.sampleRate) }),
  );
  const provider = new NodeTracerProvider({
    resource,
    // Always ParentBased, with no AlwaysOn shortcut at rate 1. They are not
    // equivalent: ParentBased honours a remote UNSAMPLED parent and drops,
    // while AlwaysOn records regardless, producing children of a span the
    // upstream service dropped. Rate 1 is the default, so the shortcut would
    // have been the default path for every user.
    // Wrapped because ParentBased follows the PARENT's sampled flag, and a
    // bridged parent's flag is the other SDK's decision (usually always-on),
    // which would ship every trace it touches whatever sampleRate says.
    sampler,
    // Already resolved against the environment; see resolveSpanLimits().
    spanLimits,
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
    : enableInstrumentations(provider, undefined, teardown, {
        instrumentModules: options.instrumentModules,
        onEnabled: (name) => {
          // From here every Anthropic call has an OpenInference LLM span, so
          // the Anthropic SDK's own chat span would be a second one.
          if (name !== "anthropic") return;
          demoter.enable();
          // Queued right after the instrumentation's own disable, so the
          // demoter stops when the instrumentation is unbound, not later.
          teardown.push(() => demoter.disable());
        },
      });

  // Registered even when disabled: a provider whose only processor has no
  // delegates costs nothing, and it keeps getTracer() returning a real tracer,
  // so caller code that starts spans behaves the same either way and
  // shutdown() has a registration to release.
  rememberOwnProvider(provider);
  ownTracerProvider = provider;
  ownGlobals = registerGlobals(provider);
  const bridged = config.disabled
    ? undefined
    : bridgeOrWarn(provider, processors, sampler, spanLimits, config.bridgeForeignProvider);

  // Heartbeat: process-lifetime liveness, independent of trace traffic. The
  // tracker rides the delegating processor so payloads can carry the
  // currently-open root trace ids; disabled kills it too.
  let heartbeat: { sender: HeartbeatSender; beforeExitHandler: () => void } | undefined;
  // Without credentials (an API key, or an Authorization header of the
  // caller's own) the managed endpoint rejects every ping with 401, so the
  // default transport would only produce a warn-once and 15-second failures.
  // An injected transport (tests, own collectors) knows better. Credentials
  // given only through OTEL_EXPORTER_OTLP_HEADERS reach the span exporter but
  // not this check.
  const heartbeatCanAuthenticate =
    options.heartbeatTransport !== undefined || hasAuthorization(config.headers);
  if (config.heartbeat && !config.disabled && heartbeatCanAuthenticate) {
    const tracker = new OpenRootSpanTracker();
    processors.add(tracker);
    const sender = new HeartbeatSender({
      url: config.heartbeatEndpoint,
      headers: config.headers,
      intervalMs: config.heartbeatIntervalMs,
      agentName: config.agentName,
      instanceId,
      tracker,
      transport: options.heartbeatTransport,
      foreignParentSpans: detector === undefined ? undefined : () => detector.count,
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

  globalClient = createClient({
    provider,
    processors,
    health,
    ready,
    teardown,
    heartbeat,
    bridge: bridged,
  });
  setGlobalRouting(routing, config.disabled);
  // AGENT spans fall back to this when the caller names no agent.
  setConfiguredAgentName(config.agentName);
  return globalClient;
}

/**
 * Attach Rius's pipeline to whichever provider won the OpenTelemetry global, or
 * explain why it did not.
 *
 * Called after the global registration, and a no-op when it took. The
 * loser is not always another vendor: a provider this SDK built in an earlier
 * init() holds the global just as firmly, and its spans are just as invisible
 * to the new client. Rius's own helpers (`observe`, `startSpan`, the
 * generation helpers) follow this client either way, but third-party code
 * calling `trace.getTracer()` keeps the pre-existing provider, and LLM spans
 * started inside its spans arrive without their parent.
 */
function bridgeOrWarn(
  own: TracerProvider,
  pipeline: DelegatingSpanProcessor,
  sampler: BridgeAwareSampler,
  spanLimits: SpanLimits,
  bridgeForeignProvider: boolean,
): Bridge | undefined {
  const existing = globalTracerProvider();
  if (existing === undefined || existing === own) return undefined;
  const foreignGlobal = existing.constructor?.name || "unknown";
  if (bridgeForeignProvider) {
    const attached = bridge(existing, pipeline, sampler, spanLimits);
    if (attached !== undefined) {
      console.info(
        `[rius] the OpenTelemetry global tracer provider was already set (${foreignGlobal}); Rius attached its span pipeline to it, so spans started through it are exported to Rius too.`,
      );
      return attached;
    }
  }
  const why = bridgeForeignProvider
    ? "it takes no additional span processor"
    : "bridgeForeignProvider is off";
  console.warn(
    `[rius] could not register the Rius tracer provider as the OpenTelemetry global (${foreignGlobal} is already set, or a previous init() claimed it), and Rius is not attached to it (${why}). Rius' own helpers (observe, startSpan, generations) follow this client regardless; third-party code using trace.getTracer() keeps the pre-existing provider, and LLM spans started inside its spans arrive without their parent. Set RIUS_BRIDGE_FOREIGN_PROVIDER=true or init({ bridgeForeignProvider: true }) to send that provider's spans to Rius as well.`,
  );
  return undefined;
}

/**
 * The provider this SDK built, whether or not it won the OpenTelemetry global.
 *
 * `getTracer()` must not read the global: when another SDK already holds it
 * (see foreign.ts) `trace.getTracer()` hands back THAT SDK's tracer, so Rius'
 * own helpers would start their spans on the other vendor's pipeline — exported
 * by it, and never seen by Rius. Cleared on shutdown, where the global
 * registration is released too.
 */
let ownTracerProvider: NodeTracerProvider | undefined;

/** The SDK tracer. Scope name is wire-visible; do not parameterize it. */
export function getTracer(): Tracer {
  return (ownTracerProvider ?? trace).getTracer(TRACER_NAME, SDK_VERSION);
}
