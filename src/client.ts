import { type Tracer, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  type SpanExporter,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { type RiusOptions, resolveConfig } from "./config.js";
import { DelegatingSpanProcessor } from "./delegatingProcessor.js";
import { ExportOutcomeExporter } from "./exportHealth.js";
import { HeartbeatSender, type HeartbeatTransport, OpenRootSpanTracker } from "./heartbeat.js";
import { enableInstrumentations } from "./instrumentation.js";
import { MaskingSpanExporter } from "./masking.js";
import { PendingSpanProcessor } from "./pending.js";
import { TRACER_NAME } from "./semconv.js";

export interface InitOptions extends RiusOptions {
  /** Inject an exporter instead of OTLP. The test seam; prefer this to mocking. */
  spanExporter?: SpanExporter;
  /** Override the heartbeat HTTP transport. The test seam; prefer this to mocking fetch. */
  heartbeatTransport?: HeartbeatTransport;
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

export class RiusClient {
  private readonly provider: NodeTracerProvider;
  private readonly health?: ExportOutcomeExporter;

  /** Resolves with the names of the auto-instrumentations that attached. */
  readonly ready: Promise<string[]>;

  private constructor(parts: ClientParts) {
    this.provider = parts.provider;
    this.health = parts.health;
    this.ready = parts.ready;
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
    try {
      await this.provider.shutdown();
    } finally {
      if (globalClient === this) {
        globalClient = undefined;
        trace.disable();
      }
    }
  }
}

let globalClient: RiusClient | undefined;

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
  if (!config.disabled) {
    const base =
      options.spanExporter ??
      new OTLPTraceExporter({
        url: `${config.endpoint}/v1/traces`,
        headers: config.apiKey ? authHeaders : undefined,
      });
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
    if (config.partialSpans) {
      // Pending must see onStart/onEnd before the batch processor queues the
      // span for export, so it goes in ahead of it.
      processors.add(new PendingSpanProcessor(batch, { delayMs: config.partialSpansDelayMs }));
    }
    processors.add(batch);
  }

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.serviceName }),
    // Always ParentBased, with no AlwaysOn shortcut at rate 1. They are not
    // equivalent: ParentBased honours a remote UNSAMPLED parent and drops,
    // while AlwaysOn records regardless, producing children of a span the
    // upstream service dropped. Rate 1 is the default, so the shortcut would
    // have been the default path for every user.
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.sampleRate) }),
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
  const ready = config.disabled
    ? Promise.resolve<string[]>([])
    : enableInstrumentations(processors, provider).catch(() => [] as string[]);

  // Registered even when disabled: a provider whose only processor has no
  // delegates costs nothing, and it keeps getTracer() returning a real tracer,
  // so caller code that starts spans behaves the same either way and
  // shutdown() has a registration to release.
  provider.register();

  // Heartbeat: process-lifetime liveness, independent of trace traffic. The
  // tracker rides the delegating processor so payloads can carry the
  // currently-open root trace ids; disabled kills it too.
  let heartbeat: { sender: HeartbeatSender; beforeExitHandler: () => void } | undefined;
  if (config.heartbeat && !config.disabled) {
    const tracker = new OpenRootSpanTracker();
    processors.add(tracker);
    const sender = new HeartbeatSender({
      url: config.heartbeatEndpoint,
      headers: authHeaders,
      intervalMs: config.heartbeatIntervalMs,
      agentName: config.agentName,
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

  globalClient = createClient({ provider, processors, health, ready, heartbeat });
  return globalClient;
}

/** The SDK tracer. Scope name is wire-visible; do not parameterize it. */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}
