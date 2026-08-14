import type { Attributes, Context } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  GLASSFLOW_SPAN_PENDING,
  PENDING_IDENTITY_ATTRIBUTES,
  PENDING_IDENTITY_PREFIXES,
} from "./semconv.js";

/**
 * Partial (pending) spans: a content-free snapshot exported at span start.
 *
 * Spans normally leave the process only when they END, so an in-flight agent
 * run is invisible and a crashed one exports nothing. Every sampled span
 * additionally exports a snapshot at START; the backend stores it as an
 * unfinished row that the real span replaces at end (same trace/span id and
 * start timestamp, the identity the storage layer keys replacement on), and a
 * snapshot that is never replaced is the durable record of what a crashed
 * agent was doing. Ported from the Python SDK's `pending.py`, which is
 * normative for the wire contract below.
 *
 * Wire contract:
 * - Same trace id, span id, parent, name, and start timestamp as the final
 *   span; `endTime == startTime` (OTLP cannot represent an unfinished span,
 *   so the snapshot is an ended zero-duration span with a marker).
 * - The `glassflow.span.pending` marker attribute (see semconv.ts).
 * - Identity/taxonomy attributes only (`PENDING_IDENTITY_ATTRIBUTES` /
 *   `_PREFIXES`); never content, whatever instrumentation set it.
 *
 * Debounce: with `delayMs > 0` the snapshot is held for that long and only
 * emitted if the span is STILL OPEN then; a span that finishes first costs
 * zero network. The snapshot is built at `onStart` and held, never rebuilt at
 * emit time: content set during the delay can never leak onto a pending. A
 * delayed pending is byte-identical to an immediate one.
 */

function identityAttributes(attributes: Attributes | undefined): Attributes {
  if (!attributes) return {};
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (
      PENDING_IDENTITY_ATTRIBUTES.has(key) ||
      PENDING_IDENTITY_PREFIXES.some((p) => key.startsWith(p))
    ) {
      result[key] = value;
    }
  }
  return result;
}

/** Built once at onStart and never touched again: this is the privacy boundary. */
function buildSnapshot(span: Span): ReadableSpan {
  const attributes = identityAttributes(span.attributes);
  attributes[GLASSFLOW_SPAN_PENDING] = true;

  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.startTime,
    duration: [0, 0],
    status: { code: SpanStatusCode.UNSET },
    attributes,
    links: [],
    events: [],
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    ended: true,
  } satisfies ReadableSpan;
}

function spanKey(context: { traceId: string; spanId: string }): string {
  return `${context.traceId}:${context.spanId}`;
}

/**
 * Exports a pending snapshot of every sampled span at `onStart`.
 *
 * Delegates the snapshot to the provider's existing batch processor
 * (`delegate.onEnd`), so pendings share the exporter, batching, retry, and
 * masking pipeline with final spans; nothing bespoke touches the wire.
 * `onStart` stays an in-memory enqueue: the never-block guarantee holds.
 *
 * With `delayMs > 0` emission is debounced via a per-span timer, keyed by
 * `${traceId}:${spanId}`; `onEnd` clears the timer so a span that finishes
 * within the delay never emits its pending. `delayMs` 0 or absent emits
 * synchronously inside `onStart`, no timers at all.
 */
export class PendingSpanProcessor implements SpanProcessor {
  private readonly delegate: SpanProcessor;
  private readonly delayMs: number;
  private readonly scheduled = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(delegate: SpanProcessor, opts?: { delayMs?: number }) {
    this.delegate = delegate;
    this.delayMs = opts?.delayMs ?? 0;
  }

  onStart(span: Span, _parentContext: Context): void {
    if (!span.isRecording()) return;
    const snapshot = buildSnapshot(span);

    if (this.delayMs <= 0) {
      this.delegate.onEnd(snapshot);
      return;
    }

    const key = spanKey(span.spanContext());
    const timer = setTimeout(() => {
      this.scheduled.delete(key);
      try {
        this.delegate.onEnd(snapshot);
      } catch {
        // A detached timer callback must never surface as an uncaught
        // exception; a failed pending export must not affect the live span.
      }
    }, this.delayMs);
    // A live timer would otherwise hold the process open; a pending is not a
    // reason to keep it running.
    if (typeof timer.unref === "function") timer.unref();
    this.scheduled.set(key, timer);
  }

  onEnd(span: ReadableSpan): void {
    // The debounce cancellation hook: a span that ends within the delay never
    // sends its pending at all.
    const key = spanKey(span.spanContext());
    const timer = this.scheduled.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.scheduled.delete(key);
  }

  async shutdown(): Promise<void> {
    // Drop everything not yet due: the final spans are being flushed at this
    // moment, so any pending emitted now would be instantly superseded.
    for (const timer of this.scheduled.values()) clearTimeout(timer);
    this.scheduled.clear();
  }

  async forceFlush(): Promise<void> {
    // Deliberately NOT a drop: flush() happens mid-operation, so killing
    // scheduled pendings here would silently disable liveness for spans that
    // stay open. The delegate flushes its own queue; not-yet-due pendings
    // simply emit later if their spans are still open.
  }
}
