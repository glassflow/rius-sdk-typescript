/**
 * Another SDK's tracer provider in the same process (RIUS-1097 / RIUS-1070).
 *
 * The OpenTelemetry global provider is write-once. When another SDK (Langfuse
 * v3, for one) claims it before `init()`, Rius keeps a private provider and its
 * instrumentors bind to that, but span CONTEXT is process-wide: an LLM call
 * made inside a span of the other provider takes that span as parent, and Rius
 * exports a child whose parent it never receives.
 *
 * Four pieces address this:
 *
 * - {@link bridge} (opt-in: `bridgeForeignProvider: true`) attaches Rius's
 *   span-processor pipeline to the other provider, so its spans (the parents)
 *   reach Rius too, as they would had Rius won the race and become the global.
 *   Off by default: exporting another SDK's spans needs the caller's consent.
 * - {@link ShadowPipeline} keeps Rius's hands off those spans. A live span has
 *   one attribute bag and the other provider exports it too, so whatever Rius
 *   stamped on it (session, user, route, canonical keys) would reach the other
 *   vendor. Rius's pipeline works on a private twin instead, and exports a copy
 *   of the finished span carrying what it added to the twin. It also applies
 *   Rius's sampling decision, which {@link BridgeAwareSampler} then extends to
 *   Rius's own spans started under a bridged parent.
 * - {@link ResourceAdoptingExporter} gives those bridged spans Rius's resource
 *   identity at export: the sink derives agent name and instance id from
 *   resource attributes, and the other provider's resource carries neither.
 * - {@link ForeignParentDetector} flags a span whose parent is local
 *   (`isRemote !== true`) yet never started through Rius's pipeline. That parent
 *   can only belong to another in-process provider; remote parents are ordinary
 *   distributed tracing and are never flagged. It runs with the bridge off too,
 *   which is how Rius tells the caller the bridge exists.
 */

import {
  type AttributeValue,
  type Attributes,
  type Context,
  type Exception,
  type HrTime,
  type Link,
  ProxyTracerProvider,
  type SpanContext,
  type SpanKind,
  type SpanStatus,
  SpanStatusCode,
  type TimeInput,
  type TracerProvider,
  isSpanContextValid,
  trace,
} from "@opentelemetry/api";
import type { InstrumentationScope } from "@opentelemetry/core";
import { type Resource, resourceFromAttributes } from "@opentelemetry/resources";
import type {
  ReadableSpan,
  Sampler,
  Span,
  SpanExporter,
  SpanLimits,
  SpanProcessor,
  TimedEvent,
} from "@opentelemetry/sdk-trace-base";
import { SamplingDecision } from "@opentelemetry/sdk-trace-base";
import { RIUS_PARENT_FOREIGN } from "./semconv.js";

/* ------------------------------------------------------------------ *
 * Which provider holds the OpenTelemetry global
 * ------------------------------------------------------------------ */

/**
 * Every provider `init()` built, so a global left over from an earlier
 * shutdown()+init() cycle is recognised as ours rather than another SDK's.
 */
const ownProviders = new WeakSet<object>();

/** The module-singleton no-op provider a never-delegated proxy returns. */
const NOOP_PROVIDER = new ProxyTracerProvider().getDelegate();

/** A proxy provider, structurally: two copies of the API do not share a class. */
interface Delegating {
  getDelegate(): TracerProvider;
}

function delegating(provider: TracerProvider): provider is TracerProvider & Delegating {
  return typeof (provider as Partial<Delegating>).getDelegate === "function";
}

export function rememberOwnProvider(provider: TracerProvider): void {
  ownProviders.add(provider);
}

/**
 * The provider actually serving `trace.getTracer()`, or undefined when nobody
 * has registered one.
 *
 * `trace.getTracerProvider()` never returns the registered provider itself: the
 * API wraps every registration in a `ProxyTracerProvider`, so the real one is
 * the proxy's delegate, and an unset proxy delegates to a shared no-op.
 */
export function globalTracerProvider(): TracerProvider | undefined {
  let provider = trace.getTracerProvider();
  // Duck-typed, not `instanceof`: a bundler (or a test runner's module
  // transform) can leave two copies of @opentelemetry/api in one process, and
  // the proxy holding the global is then not an instance of *our* class. The
  // loop handles a proxy registered on another proxy; the bound is a guard
  // against a delegation cycle, not an expected depth.
  for (let hop = 0; hop < 8 && delegating(provider); hop += 1) {
    const delegate = provider.getDelegate();
    if (delegate === provider) break;
    provider = delegate;
  }
  // Same hazard for the sentinel: compare by identity first, then by name for a
  // no-op that came from another copy of the API.
  if (provider === NOOP_PROVIDER || provider.constructor?.name === "NoopTracerProvider") {
    return undefined;
  }
  return provider;
}

/**
 * The class name of the global provider when another SDK already set it, else
 * undefined.
 *
 * A name only, and only for the resource and the warning: TypeScript has no
 * `module.QualName`, and a bundler may rename the class, so it is a hint rather
 * than an identifier.
 */
export function foreignGlobalProviderName(): string | undefined {
  const provider = globalTracerProvider();
  if (provider === undefined || ownProviders.has(provider)) return undefined;
  return provider.constructor?.name || "unknown";
}

/* ------------------------------------------------------------------ *
 * Detection (always on, bridge or no bridge)
 * ------------------------------------------------------------------ */

/**
 * Stamps `rius.parent.foreign` on spans whose local parent Rius never saw.
 *
 * "Seen" is recorded twice, because neither test alone is sound:
 *
 * - By identity, in a weak set of the span objects this pipeline started. It
 *   needs no removal at `onEnd`: a child names its local parent through a
 *   context holding the parent span object, which keeps it alive for exactly as
 *   long as the lookup matters, ended or not.
 * - By span id, for the spans currently open. A context does not always carry
 *   the object the pipeline started: OpenInference (which Rius's own
 *   instrumentations use) puts an `OISpan` proxy in it, and a child started
 *   under one would fail the identity test although its parent is Rius's.
 *   Dropped at `onEnd`, so this set is bounded by open spans.
 *
 * With the bridge on, the other provider's spans pass through `onStart` as their
 * twins, so they count as seen and their children are correctly left unflagged.
 */
export class ForeignParentDetector implements SpanProcessor {
  private readonly seen = new WeakSet<object>();
  private readonly openIds = new Set<string>();
  private readonly globalProvider?: string;
  /** Spans flagged since this detector was built. Cumulative; never reset. */
  count = 0;

  constructor(globalProvider?: string) {
    this.globalProvider = globalProvider;
  }

  onStart(span: Span, parentContext: Context): void {
    const parent = span.parentSpanContext;
    const foreign =
      parent !== undefined &&
      isSpanContextValid(parent) &&
      // A remote parent belongs to another PROCESS: ordinary distributed
      // tracing, where the parent was never expected here.
      parent.isRemote !== true &&
      !this.startedHere(parent, parentContext);
    this.remember(span);
    if (!foreign) return;
    this.count += 1;
    span.setAttribute(RIUS_PARENT_FOREIGN, true);
    if (this.count === 1) this.warn(span.name);
  }

  private startedHere(parent: SpanContext, parentContext: Context): boolean {
    if (this.seen.has(twinOf(trace.getSpan(parentContext)) as object)) return true;
    return this.openIds.has(parent.spanId);
  }

  private remember(span: Span): void {
    this.seen.add(span);
    this.openIds.add(span.spanContext().spanId);
  }

  private warn(name: string): void {
    const owner =
      this.globalProvider === undefined
        ? "another OpenTelemetry provider in this process"
        : `another OpenTelemetry SDK (${this.globalProvider})`;
    const first = `first: ${JSON.stringify(name)}, flagged ${RIUS_PARENT_FOREIGN}`;
    console.warn(
      `[rius] ${owner} owns the global tracer provider; Rius spans have parents it never receives (${first}). Set RIUS_BRIDGE_FOREIGN_PROVIDER=true or init({ bridgeForeignProvider: true }) to send them to Rius.`,
    );
  }

  onEnd(span: ReadableSpan): void {
    // Flagging happens at start, where the parent is reachable; all that is left
    // is to stop holding the id of a span nothing can name as its parent by
    // context any more.
    this.openIds.delete(span.spanContext().spanId);
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

/* ------------------------------------------------------------------ *
 * The shadow registry
 * ------------------------------------------------------------------ */

interface Shadow {
  readonly twin: TwinSpan;
  /** The attributes the other SDK had already set when Rius first saw the span. */
  readonly seed: Attributes;
}

/**
 * The bridged spans Rius sampled in (with their shadow) and those it dropped.
 *
 * Weak keys: an entry lives exactly as long as the other SDK's span. OTel JS
 * hands the SAME object to `onStart` and `onEnd`, so unlike Python this needs no
 * secondary index by span context.
 */
const shadows = new WeakMap<object, Shadow>();
const dropped = new WeakSet<object>();

/** The twin Rius's pipeline saw in place of a bridged span; any other span as is. */
export function twinOf<T>(span: T): T | TwinSpan {
  if (span === undefined || span === null) return span;
  return shadows.get(span as object)?.twin ?? span;
}

/** Whether Rius sampled a bridged span in, or undefined when it is not one. */
function riusDecision(span: unknown): boolean | undefined {
  if (span === undefined || span === null) return undefined;
  if (dropped.has(span as object)) return false;
  return shadows.has(span as object) ? true : undefined;
}

/* ------------------------------------------------------------------ *
 * Sampling
 * ------------------------------------------------------------------ */

const ALWAYS_ON: Sampler = {
  shouldSample: () => ({ decision: SamplingDecision.RECORD_AND_SAMPLED }),
  toString: () => "AlwaysOnSampler",
};

const ALWAYS_OFF: Sampler = {
  shouldSample: () => ({ decision: SamplingDecision.NOT_RECORD }),
  toString: () => "AlwaysOffSampler",
};

/**
 * Rius's sampler, following Rius's own decision on a bridged parent.
 *
 * `ParentBasedSampler` follows the parent's sampled flag, and a bridged parent's
 * flag is the other SDK's decision (usually always-on), which would ship every
 * trace it touches whatever `sampleRate` says.
 */
export class BridgeAwareSampler implements Sampler {
  private readonly inner: Sampler;

  constructor(inner: Sampler) {
    this.inner = inner;
  }

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ) {
    const kept = riusDecision(trace.getSpan(context));
    const sampler = kept === undefined ? this.inner : kept ? ALWAYS_ON : ALWAYS_OFF;
    return sampler.shouldSample(context, traceId, spanName, spanKind, attributes, links);
  }

  toString(): string {
    return `BridgeAware{${this.inner.toString()}}`;
  }
}

/* ------------------------------------------------------------------ *
 * The twin
 * ------------------------------------------------------------------ */

/**
 * A span no provider owns: Rius's pipeline stamps it in place of a bridged span.
 *
 * Hand-written rather than OTel's `SpanImpl`, whose constructor wants a provider's
 * internals (a span processor, resolved limits, an owning context) and whose
 * `end()` would push the twin back into a pipeline that is already handling the
 * real span.
 */
export class TwinSpan implements Span {
  readonly attributes: Attributes = {};
  readonly links: Link[];
  readonly events: TimedEvent[] = [];
  readonly startTime: HrTime;
  readonly endTime: HrTime = [0, 0];
  readonly duration: HrTime = [0, 0];
  readonly resource: Resource;
  readonly instrumentationScope: InstrumentationScope;
  readonly kind: SpanKind;
  readonly parentSpanContext?: SpanContext;
  droppedAttributesCount = 0;
  droppedEventsCount = 0;
  droppedLinksCount = 0;
  name: string;
  status: SpanStatus = { code: SpanStatusCode.UNSET };
  ended = false;

  private readonly context: SpanContext;
  private readonly attributeCountLimit: number;
  private readonly attributeValueLengthLimit: number;

  constructor(span: Span, limits?: SpanLimits) {
    this.context = span.spanContext();
    this.name = span.name;
    this.kind = span.kind;
    this.parentSpanContext = span.parentSpanContext;
    this.startTime = span.startTime;
    this.resource = span.resource;
    this.instrumentationScope = span.instrumentationScope;
    this.links = [...span.links];
    this.attributeCountLimit = limits?.attributeCountLimit ?? Number.POSITIVE_INFINITY;
    this.attributeValueLengthLimit = limits?.attributeValueLengthLimit ?? Number.POSITIVE_INFINITY;
    Object.assign(this.attributes, span.attributes);
  }

  spanContext(): SpanContext {
    return this.context;
  }

  setAttribute(key: string, value?: AttributeValue): this {
    if (value === undefined || key.length === 0) return this;
    if (
      !(key in this.attributes) &&
      Object.keys(this.attributes).length >= this.attributeCountLimit
    ) {
      this.droppedAttributesCount += 1;
      return this;
    }
    this.attributes[key] = this.truncate(value);
    return this;
  }

  /**
   * The value-length limit, applied as the SDK's own Span applies it: strings
   * are cut, string arrays are cut element by element, everything else passes.
   */
  private truncate(value: AttributeValue): AttributeValue {
    const limit = this.attributeValueLengthLimit;
    if (limit === Number.POSITIVE_INFINITY) return value;
    if (typeof value === "string") return value.substring(0, limit);
    if (Array.isArray(value)) {
      return value.map((item) => (typeof item === "string" ? item.substring(0, limit) : item)) as
        | string[]
        | number[]
        | boolean[];
    }
    return value;
  }

  setAttributes(attributes: Attributes): this {
    for (const [key, value] of Object.entries(attributes)) this.setAttribute(key, value);
    return this;
  }

  addEvent(name: string, attributesOrStartTime?: Attributes | TimeInput, _timeStamp?: TimeInput) {
    const attributes =
      attributesOrStartTime !== undefined && typeof attributesOrStartTime === "object"
        ? (attributesOrStartTime as Attributes)
        : undefined;
    this.events.push({ name, attributes, time: this.startTime, droppedAttributesCount: 0 });
    return this;
  }

  addLink(link: Link): this {
    this.links.push(link);
    return this;
  }

  addLinks(links: Link[]): this {
    this.links.push(...links);
    return this;
  }

  setStatus(status: SpanStatus): this {
    this.status = status;
    return this;
  }

  updateName(name: string): this {
    this.name = name;
    return this;
  }

  end(_endTime?: TimeInput): void {
    // The real span's lifecycle drives the pipeline; ending the twin is a no-op
    // so nothing can export it twice.
    this.ended = true;
  }

  isRecording(): boolean {
    return !this.ended;
  }

  /**
   * An own property rather than a prototype method on purpose: errorType.ts
   * replaces it per span instance, which a readonly method would refuse.
   */
  recordException: (exception: Exception, time?: TimeInput) => void = () => {
    // Events on the twin are never exported (the finished span carries its own),
    // so there is nothing to record. The assignable shape is the point.
  };
}

/* ------------------------------------------------------------------ *
 * The pipeline rius runs over another provider's spans
 * ------------------------------------------------------------------ */

/**
 * The finished span plus what Rius's pipeline wrote on its twin at start.
 *
 * A key the other SDK rewrote after start keeps that value, as a later
 * `setAttribute` wins over a start-time stamp on Rius's own spans.
 *
 * Events, links and status are COPIED, not shared: `MaskingSpanExporter`
 * sanitises them in place, and they belong to a span the other vendor is
 * exporting at the same time.
 */
function stamped(span: ReadableSpan, shadow: Shadow): ReadableSpan {
  const attributes: Attributes = { ...span.attributes };
  for (const [key, value] of Object.entries(shadow.twin.attributes)) {
    const started = shadow.seed[key];
    const own = attributes[key];
    if (value !== started && own === started) attributes[key] = value;
  }
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    status: { ...span.status },
    attributes,
    links: span.links.map((link) => ({ ...link, attributes: { ...link.attributes } })),
    events: span.events.map((event) => ({ ...event, attributes: { ...event.attributes } })),
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
    ended: span.ended,
  } satisfies ReadableSpan;
}

/**
 * Rius's pipeline as another provider feeds it, never writing to that provider's
 * spans.
 *
 * Spans Rius's sampler drops never reach the pipeline, and neither does a span
 * that started before the bridge was attached: Rius never saw it start, so its
 * children are flagged `rius.parent.foreign` instead.
 */
export class ShadowPipeline implements SpanProcessor {
  private readonly pipeline: SpanProcessor;
  private readonly sampler: Sampler;
  private readonly limits?: SpanLimits;

  constructor(pipeline: SpanProcessor, sampler: Sampler, limits?: SpanLimits) {
    this.pipeline = pipeline;
    this.sampler = sampler;
    this.limits = limits;
  }

  onStart(span: Span, parentContext: Context): void {
    const result = this.sampler.shouldSample(
      parentContext,
      span.spanContext().traceId,
      span.name,
      span.kind,
      span.attributes,
      span.links,
    );
    if (result.decision !== SamplingDecision.RECORD_AND_SAMPLED) {
      dropped.add(span);
      return;
    }
    const twin = new TwinSpan(span, this.limits);
    shadows.set(span, { twin, seed: { ...span.attributes } });
    this.pipeline.onStart(twin, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    const shadow = shadows.get(span as object);
    if (shadow !== undefined) this.pipeline.onEnd(stamped(span, shadow));
  }

  async forceFlush(): Promise<void> {
    // The rider never flushes its target: that is the other provider's call.
  }

  async shutdown(): Promise<void> {
    // The rider never shuts its target down.
  }
}

/* ------------------------------------------------------------------ *
 * Attaching to (and detaching from) the other provider
 * ------------------------------------------------------------------ */

/**
 * The one processor Rius ever adds to another provider.
 *
 * Its lifecycle belongs to Rius, not to the provider it rides: that provider's
 * `shutdown`/`forceFlush` do nothing here, and `release` makes it inert, since
 * OTel offers no way to remove a processor.
 */
class Forwarder implements SpanProcessor {
  private target?: SpanProcessor;

  attach(target: SpanProcessor): void {
    this.target = target;
  }

  release(target: SpanProcessor): void {
    if (this.target === target) this.target = undefined;
  }

  onStart(span: Span, parentContext: Context): void {
    this.target?.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    this.target?.onEnd(span);
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

/**
 * One forwarder per provider, re-targeted on every init(), so a
 * shutdown()+init() cycle never stacks a second one on a provider that cannot
 * drop the first.
 */
const forwarders = new WeakMap<object, Forwarder>();

/** Handle on Rius's pipeline attached to another provider. */
export class Bridge {
  private readonly forwarder: Forwarder;
  private readonly pipeline: SpanProcessor;

  constructor(forwarder: Forwarder, pipeline: SpanProcessor) {
    this.forwarder = forwarder;
    this.pipeline = pipeline;
  }

  /** Stop feeding the other provider's spans into this pipeline. Idempotent. */
  release(): void {
    this.forwarder.release(this.pipeline);
  }
}

/** A provider that still takes processors after construction (OpenTelemetry JS 1.x). */
interface AddsSpanProcessors {
  addSpanProcessor(processor: SpanProcessor): void;
}

/**
 * OpenTelemetry JS 2.x builds the provider's processor list at construction and
 * exposes no way to extend it. The list is not copied: `MultiSpanProcessor`
 * holds the very array it was given, and every `Tracer` the provider makes
 * shares that one instance — the provider's own `forceFlush` reaches into it
 * the same way. Pushing onto it is therefore the whole of "add a processor"
 * on 2.x, and it is the only unofficial reach in this file.
 */
interface HasActiveProcessorList {
  _activeSpanProcessor?: { _spanProcessors?: SpanProcessor[] };
}

function attachProcessor(provider: TracerProvider, processor: SpanProcessor): boolean {
  const legacy = provider as unknown as Partial<AddsSpanProcessors>;
  if (typeof legacy.addSpanProcessor === "function") {
    legacy.addSpanProcessor(processor);
    return true;
  }
  const list = (provider as unknown as HasActiveProcessorList)._activeSpanProcessor
    ?._spanProcessors;
  if (Array.isArray(list)) {
    list.push(processor);
    return true;
  }
  return false;
}

/**
 * Feed the spans `provider` starts and ends that `sampler` keeps into
 * `pipeline`. Returns undefined when the provider takes no processor at all,
 * in which case detection (and its warning) still stands.
 *
 * `limits` are Rius's own, so a bridged span's twin truncates as an own span
 * would.
 */
export function bridge(
  provider: TracerProvider,
  pipeline: SpanProcessor,
  sampler: Sampler,
  limits?: SpanLimits,
): Bridge | undefined {
  const shadow = new ShadowPipeline(pipeline, sampler, limits);
  let forwarder = forwarders.get(provider);
  if (forwarder === undefined) {
    forwarder = new Forwarder();
    if (!attachProcessor(provider, forwarder)) return undefined;
    forwarders.set(provider, forwarder);
  }
  forwarder.attach(shadow);
  return new Bridge(forwarder, shadow);
}

/* ------------------------------------------------------------------ *
 * Export identity
 * ------------------------------------------------------------------ */

/**
 * Export spans of a bridged provider under Rius's resource identity.
 *
 * The other provider's resource wins nothing it shares with `resource`
 * (`service.name`, `service.instance.id`, the agent identity keys) and keeps
 * whatever else it carries. Spans of Rius's own provider pass through untouched.
 */
export class ResourceAdoptingExporter implements SpanExporter {
  private readonly inner: SpanExporter;
  private readonly resource: Resource;
  private readonly adoptedResources = new WeakMap<object, Resource>();

  constructor(inner: SpanExporter, resource: Resource) {
    this.inner = inner;
    this.resource = resource;
  }

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    this.inner.export(
      spans.map((span) => this.adopted(span)),
      resultCallback,
    );
  }

  private adopted(span: ReadableSpan): ReadableSpan {
    if (span.resource === this.resource) return span;
    let merged = this.adoptedResources.get(span.resource);
    if (merged === undefined) {
      // Not resource.merge(): on a schema-url conflict OTel keeps the OLD
      // resource and drops the update entirely.
      merged = resourceFromAttributes(
        { ...span.resource.attributes, ...this.resource.attributes },
        { schemaUrl: this.resource.schemaUrl ?? span.resource.schemaUrl },
      );
      this.adoptedResources.set(span.resource, merged);
    }
    return { ...span, spanContext: () => span.spanContext(), resource: merged };
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
