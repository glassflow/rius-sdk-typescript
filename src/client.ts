import { type Tracer, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AlwaysOnSampler,
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
import { MaskingSpanExporter } from "./masking.js";
import { TRACER_NAME } from "./semconv.js";

export interface InitOptions extends RiusOptions {
  /** Inject an exporter instead of OTLP. The test seam; prefer this to mocking. */
  spanExporter?: SpanExporter;
}

export class RiusClient {
  /** @internal Later-resolving instrumentation contributes processors here. */
  readonly processors: DelegatingSpanProcessor;

  private readonly provider: NodeTracerProvider;
  private readonly health?: ExportOutcomeExporter;

  constructor(
    provider: NodeTracerProvider,
    processors: DelegatingSpanProcessor,
    health?: ExportOutcomeExporter,
  ) {
    this.provider = provider;
    this.processors = processors;
    this.health = health;
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
    sampler:
      config.sampleRate >= 1
        ? new AlwaysOnSampler()
        : new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.sampleRate) }),
    spanProcessors: [processors],
  });

  provider.register();
  globalClient = new RiusClient(provider, processors, health);
  return globalClient;
}

/** The SDK tracer. Scope name is wire-visible; do not parameterize it. */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}
