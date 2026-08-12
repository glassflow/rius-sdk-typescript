import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import { DelegatingSpanProcessor } from "../src/delegatingProcessor.js";

function stub(): SpanProcessor {
  return {
    onStart: vi.fn(),
    onEnd: vi.fn(),
    forceFlush: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

const span = { name: "s" } as unknown as Span & ReadableSpan;
const context = {} as Context;

describe("DelegatingSpanProcessor", () => {
  it("forwards onStart and onEnd to every delegate", () => {
    const processors = new DelegatingSpanProcessor();
    const a = stub();
    const b = stub();
    processors.add(a);
    processors.add(b);

    processors.onStart(span, context);
    processors.onEnd(span);

    for (const delegate of [a, b]) {
      expect(delegate.onStart).toHaveBeenCalledWith(span, context);
      expect(delegate.onEnd).toHaveBeenCalledWith(span);
    }
  });

  it("delivers subsequent spans to a delegate added after construction", () => {
    const processors = new DelegatingSpanProcessor();
    const early = stub();
    processors.add(early);
    processors.onEnd(span);

    const late = stub();
    processors.add(late);
    processors.onEnd(span);

    expect(early.onEnd).toHaveBeenCalledTimes(2);
    expect(late.onEnd).toHaveBeenCalledTimes(1);
  });

  it("awaits every delegate on forceFlush", async () => {
    const processors = new DelegatingSpanProcessor();
    let resolved = false;
    const slow = stub();
    slow.forceFlush = vi.fn(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            resolved = true;
            resolve();
          }, 5),
        ),
    );
    const fast = stub();
    processors.add(slow);
    processors.add(fast);

    await processors.forceFlush();

    expect(resolved).toBe(true);
    expect(fast.forceFlush).toHaveBeenCalledTimes(1);
  });

  it("awaits every delegate on shutdown", async () => {
    const processors = new DelegatingSpanProcessor();
    const a = stub();
    const b = stub();
    processors.add(a);
    processors.add(b);

    await processors.shutdown();

    expect(a.shutdown).toHaveBeenCalledTimes(1);
    expect(b.shutdown).toHaveBeenCalledTimes(1);
  });

  it("is a no-op with no delegates", async () => {
    const processors = new DelegatingSpanProcessor();

    expect(() => processors.onStart(span, context)).not.toThrow();
    expect(() => processors.onEnd(span)).not.toThrow();
    await expect(processors.forceFlush()).resolves.toBeUndefined();
    await expect(processors.shutdown()).resolves.toBeUndefined();
  });
});
