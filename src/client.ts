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
import { enableInstrumentations } from "./instrumentation.js";
import { MaskingSpanExporter } from "./masking.js";
import { TRACER_NAME } from "./semconv.js";

export interface InitOptions extends RiusOptions {
  /** Inject an exporter instead of OTLP. The test seam; prefer this to mocking. */
  spanExporter?: SpanExporter;
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

/** The internals `init()` hands to a new client. Never part of the public API. */
interface ClientParts {
  provider: NodeTracerProvider;
  processors: DelegatingSpanProcessor;
  health?: ExportOutcomeExporter;
  ready: Promise<string[]>;
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
   */
  async shutdown(): Promise<void> {
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

  let health: ExportOutcomeExporter | undefined;
  if (!config.disabled) {
    const base =
      options.spanExporter ??
      new OTLPTraceExporter({
        url: `${config.endpoint}/v1/traces`,
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
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
    processors.add(new BatchSpanProcessor(exporter));
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
  globalClient = createClient({ provider, processors, health, ready });
  return globalClient;
}

/** The SDK tracer. Scope name is wire-visible; do not parameterize it. */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}
