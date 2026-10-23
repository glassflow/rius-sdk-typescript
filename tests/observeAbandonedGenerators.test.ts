import { DiagLogLevel, diag, trace } from "@opentelemetry/api";
import { hrTimeToMilliseconds } from "@opentelemetry/core";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { init, type RiusClient } from "../src/client.js";
import { endAbandonedIteration, observe } from "../src/observe.js";
import { Observation } from "../src/spans.js";

// A generator dropped mid-iteration, neither finished nor closed, never
// reaches the wrapper's finally block. Python ends that span when the
// generator is collected (GeneratorExit); JavaScript has no such hook, so the
// SDK ends it from a FinalizationRegistry callback, best effort, once the
// abandoned generator is garbage collected.

const gc = (globalThis as { gc?: () => void }).gc;

let exporter: InMemorySpanExporter;
let client: RiusClient;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  client = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
});
afterEach(async () => {
  await client.shutdown();
});

async function finished() {
  await client.flush();
  return exporter.getFinishedSpans();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Collect garbage until `done` holds. Finalization callbacks run as their own
 * tasks some time after the collection that found their target, so each round
 * yields to the event loop before checking.
 */
async function collectUntil(done: () => Promise<boolean>): Promise<boolean> {
  if (gc === undefined) throw new Error("these tests need node --expose-gc");
  for (let round = 0; round < 50; round++) {
    gc();
    await sleep(0);
    if (await done()) return true;
  }
  return false;
}

const durationMs = (span: { startTime: [number, number]; endTime: [number, number] }) =>
  hrTimeToMilliseconds(span.endTime) - hrTimeToMilliseconds(span.startTime);

describe("a generator abandoned mid-iteration", () => {
  it("has its span ended once the generator is collected", async () => {
    const observedStream = observe(function* stream() {
      yield 1;
      yield 2;
    });
    // In its own function so nothing in this test keeps the generator alive.
    (() => {
      observedStream().next();
    })();
    expect(await finished()).toHaveLength(0);

    const ended = await collectUntil(async () => (await finished()).length === 1);
    expect(ended).toBe(true);
    expect((await finished())[0].name).toBe("stream");
  });

  it("has its async span ended once the async generator is collected", async () => {
    const observedTokens = observe(async function* tokens() {
      yield "a";
      yield "b";
    });
    await (async () => {
      await observedTokens().next();
    })();
    expect(await finished()).toHaveLength(0);

    const ended = await collectUntil(async () => (await finished()).length === 1);
    expect(ended).toBe(true);
    expect((await finished())[0].name).toBe("tokens");
  });

  it("ends the span when the last step returned, not when it was collected", async () => {
    const observedStream = observe(function* stream() {
      yield 1;
      yield 2;
      yield 3;
    });
    await (async () => {
      const iterator = observedStream();
      iterator.next();
      await sleep(100);
      iterator.next();
    })();
    // Time the generator spends abandoned is not time it spent working.
    await sleep(300);

    expect(await collectUntil(async () => (await finished()).length === 1)).toBe(true);
    const duration = durationMs((await finished())[0]);
    expect(duration).toBeGreaterThanOrEqual(95);
    expect(duration).toBeLessThan(300);
  });

  it("is not ended a second time after it completed normally", async () => {
    const observedStream = observe(function* stream() {
      yield 1;
    });
    // Ending an ended span is a no-op the OTel SDK reports as an error, which
    // is the only trace a stray finalizer would leave.
    const errors: unknown[][] = [];
    diag.setLogger(
      {
        error: (...args: unknown[]) => errors.push(args),
        warn: () => {},
        info: () => {},
        debug: () => {},
        verbose: () => {},
      },
      { logLevel: DiagLogLevel.ERROR, suppressOverrideMessage: true },
    );
    try {
      (() => {
        expect([...observedStream()]).toEqual([1]);
      })();
      // Give a stray finalizer every chance to run.
      for (let round = 0; round < 10; round++) {
        gc?.();
        await sleep(0);
      }
      expect(await finished()).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      diag.disable();
    }
  });
});

describe("the abandoned-iteration finalizer", () => {
  it("ends the span at the last step's time", async () => {
    const tracer = trace.getTracer("test");
    const observation = new Observation(tracer.startSpan("abandoned"));
    const lastStep = performance.now();
    await sleep(50);
    endAbandonedIteration({ observation, lastStep });
    const spans = await finished();
    expect(spans).toHaveLength(1);
    expect(durationMs(spans[0])).toBeLessThan(40);
  });

  it("never throws, even when ending the span does", () => {
    const span = trace.getTracer("test").startSpan("abandoned");
    span.end = () => {
      throw new Error("exporter exploded");
    };
    expect(() =>
      endAbandonedIteration({ observation: new Observation(span), lastStep: performance.now() }),
    ).not.toThrow();
  });
});
