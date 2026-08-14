import type { Context } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingSpanProcessor } from "../src/pending.js";
import { GEN_AI_OPERATION_NAME, GLASSFLOW_SPAN_PENDING, INPUT_VALUE } from "../src/semconv.js";

/** Minimal recording stub delegate, standing in for the provider's batch processor. */
function stubDelegate(): SpanProcessor & { onEnd: ReturnType<typeof vi.fn> } {
  return {
    onStart: vi.fn(),
    onEnd: vi.fn(),
    forceFlush: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeSpan(overrides: Partial<Span> = {}): Span {
  const base = {
    name: "test-span",
    kind: 0,
    parentSpanContext: undefined,
    startTime: [1000, 0],
    endTime: [1000, 0],
    status: { code: SpanStatusCode.UNSET },
    attributes: {},
    links: [],
    events: [],
    duration: [0, 0],
    ended: false,
    resource: { attributes: {} },
    instrumentationScope: { name: "test" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    spanContext: () => ({
      traceId: "0102030405060708090a0b0c0d0e0f10",
      spanId: "0102030405060708",
      traceFlags: 1,
    }),
    isRecording: () => true,
  };
  return { ...base, ...overrides } as unknown as Span;
}

describe("PendingSpanProcessor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits synchronously at onStart when delayMs is absent (0)", () => {
    const delegate = stubDelegate();
    const processor = new PendingSpanProcessor(delegate);
    const span = fakeSpan();

    processor.onStart(span, {} as Context);

    expect(delegate.onEnd).toHaveBeenCalledTimes(1);
    const snapshot = delegate.onEnd.mock.calls[0][0] as ReadableSpan;
    expect(snapshot.attributes[GLASSFLOW_SPAN_PENDING]).toBe(true);
  });

  it("emits synchronously at onStart when delayMs is explicitly 0", () => {
    const delegate = stubDelegate();
    const processor = new PendingSpanProcessor(delegate, { delayMs: 0 });
    processor.onStart(fakeSpan(), {} as Context);
    expect(delegate.onEnd).toHaveBeenCalledTimes(1);
  });

  it("snapshot carries only allowlisted attributes plus the marker, never content", () => {
    const delegate = stubDelegate();
    const processor = new PendingSpanProcessor(delegate);
    const span = fakeSpan({
      attributes: {
        [INPUT_VALUE]: "secret prompt",
        "llm.input_messages.0.message.content": "secret",
        [GEN_AI_OPERATION_NAME]: "chat",
      },
    });

    processor.onStart(span, {} as Context);

    const snapshot = delegate.onEnd.mock.calls[0][0] as ReadableSpan;
    expect(snapshot.attributes).toEqual({
      [GEN_AI_OPERATION_NAME]: "chat",
      [GLASSFLOW_SPAN_PENDING]: true,
    });
  });

  it("end == start and status UNSET even when the live span later errors", () => {
    const delegate = stubDelegate();
    const processor = new PendingSpanProcessor(delegate);
    const span = fakeSpan({ startTime: [500, 250] });

    processor.onStart(span, {} as Context);

    // Mutate the live span AFTER onStart, simulating a later error.
    (span as { status: unknown }).status = { code: SpanStatusCode.ERROR, message: "boom" };
    (span as { endTime: unknown }).endTime = [999, 0];

    const snapshot = delegate.onEnd.mock.calls[0][0] as ReadableSpan;
    expect(snapshot.startTime).toEqual([500, 250]);
    expect(snapshot.endTime).toEqual([500, 250]);
    expect(snapshot.duration).toEqual([0, 0]);
    expect(snapshot.status).toEqual({ code: SpanStatusCode.UNSET });
  });

  it("skips non-recording spans", () => {
    const delegate = stubDelegate();
    const processor = new PendingSpanProcessor(delegate);
    processor.onStart(fakeSpan({ isRecording: () => false } as never), {} as Context);
    expect(delegate.onEnd).not.toHaveBeenCalled();
  });

  it("with delay > 0, a span ending before the deadline never emits a pending", () => {
    const delegate = stubDelegate();
    const processor = new PendingSpanProcessor(delegate, { delayMs: 1000 });
    const span = fakeSpan();

    processor.onStart(span, {} as Context);
    processor.onEnd(span as unknown as ReadableSpan);

    vi.advanceTimersByTime(2000);

    expect(delegate.onEnd).not.toHaveBeenCalled();
  });

  it("with delay > 0, a span still open past the delay emits exactly the snapshot built at start", () => {
    const delegate = stubDelegate();
    const processor = new PendingSpanProcessor(delegate, { delayMs: 1000 });
    const span = fakeSpan({ attributes: { [GEN_AI_OPERATION_NAME]: "chat" } });

    processor.onStart(span, {} as Context);

    // Content set during the delay must not leak onto the snapshot.
    (span.attributes as Record<string, unknown>)[INPUT_VALUE] = "leaked?";

    vi.advanceTimersByTime(1000);

    expect(delegate.onEnd).toHaveBeenCalledTimes(1);
    const snapshot = delegate.onEnd.mock.calls[0][0] as ReadableSpan;
    expect(snapshot.attributes).toEqual({
      [GEN_AI_OPERATION_NAME]: "chat",
      [GLASSFLOW_SPAN_PENDING]: true,
    });
  });

  it("shutdown() drops scheduled pendings", () => {
    const delegate = stubDelegate();
    const processor = new PendingSpanProcessor(delegate, { delayMs: 1000 });
    processor.onStart(fakeSpan(), {} as Context);

    void processor.shutdown();
    vi.advanceTimersByTime(2000);

    expect(delegate.onEnd).not.toHaveBeenCalled();
  });

  it("forceFlush() resolves without dropping scheduled pendings", async () => {
    const delegate = stubDelegate();
    const processor = new PendingSpanProcessor(delegate, { delayMs: 1000 });
    processor.onStart(fakeSpan(), {} as Context);

    await expect(processor.forceFlush()).resolves.toBeUndefined();
    expect(delegate.onEnd).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(delegate.onEnd).toHaveBeenCalledTimes(1);
  });

  it("swallows a throwing delegate inside the timer callback", () => {
    const delegate = stubDelegate();
    delegate.onEnd.mockImplementation(() => {
      throw new Error("delegate exploded");
    });
    const processor = new PendingSpanProcessor(delegate, { delayMs: 1000 });
    processor.onStart(fakeSpan(), {} as Context);

    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
  });
});

describe("PendingSpanProcessor end-to-end (no debounce)", () => {
  it("exports both the zero-duration marked snapshot and the final span, same identity", async () => {
    vi.useRealTimers();
    const exporter = new InMemorySpanExporter();
    const simple = new SimpleSpanProcessor(exporter);
    const pending = new PendingSpanProcessor(simple);

    const provider = new BasicTracerProvider({ spanProcessors: [pending, simple] });
    const tracer = provider.getTracer("test");

    const span = tracer.startSpan("agent-run");
    const spanContext = span.spanContext();
    const startTime = (span as unknown as ReadableSpan).startTime;
    span.end();

    await provider.forceFlush();

    const exported = exporter.getFinishedSpans();
    expect(exported).toHaveLength(2);

    const [pendingSpan, finalSpan] = exported;
    expect(pendingSpan.attributes[GLASSFLOW_SPAN_PENDING]).toBe(true);
    expect(pendingSpan.duration).toEqual([0, 0]);
    expect(pendingSpan.spanContext().spanId).toBe(spanContext.spanId);
    expect(pendingSpan.spanContext().traceId).toBe(spanContext.traceId);
    expect(pendingSpan.startTime).toEqual(startTime);

    expect(finalSpan.attributes[GLASSFLOW_SPAN_PENDING]).toBeUndefined();
    expect(finalSpan.spanContext().spanId).toBe(spanContext.spanId);
    expect(finalSpan.spanContext().traceId).toBe(spanContext.traceId);
    expect(finalSpan.startTime).toEqual(startTime);

    await provider.shutdown();
  });
});
