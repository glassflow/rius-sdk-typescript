// A large message value full of escapes, exported through the normalizing
// processor as a JSON string and as a structured value: the strip and the
// media rebuild read it in time and heap linear in its size. Every "\n" in
// the text is an escape; decoding each string an escape at a time took
// seconds and over a GB of heap on this value. vitest.config.ts runs the
// workers with --expose-gc, so each measurement starts from a collected heap.

import type { Attributes } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { NormalizingSpanProcessor } from "../src/normalize.js";

const INPUT = "gen_ai.input.messages";
const gc = (globalThis as { gc?: () => void }).gc;

function onEnd(value: unknown): Attributes {
  const attributes = { [INPUT]: value } as Attributes;
  const span = {
    attributes,
    events: [],
    links: [],
    status: { code: 0 },
    startTime: [1700000000, 0],
    endTime: [1700000001, 0],
  } as unknown as ReadableSpan;
  new NormalizingSpanProcessor().onEnd(span);
  return attributes;
}

/** Seconds and heap growth of one export, the input already allocated. */
function cost(value: unknown): { seconds: number; growth: number } {
  gc?.();
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const out = onEnd(value);
  const seconds = (performance.now() - started) / 1000;
  const growth = process.memoryUsage().heapUsed - before;
  expect(out[INPUT]).toBeTypeOf("string");
  return { seconds, growth };
}

const MESSAGES = [{ role: "user", parts: [{ type: "text", content: "ab\n".repeat(10_000_000) }] }];
// Flat, so the measurement never counts flattening the input itself.
const TEXT = JSON.parse(JSON.stringify(JSON.stringify(MESSAGES))) as string;

describe("a 30 MB message value full of escapes", () => {
  it("runs with the garbage collector exposed", () => {
    expect(gc).toBeTypeOf("function");
  });

  for (const [form, value] of [
    ["a JSON string", TEXT],
    ["a structured value", MESSAGES],
  ] as const) {
    it(`exports as ${form} in linear time and heap`, () => {
      onEnd([{ role: "user", parts: [{ type: "text", content: "ab\n" }] }]); // warm
      const { seconds, growth } = cost(value);
      // The linear read takes well under a second and a few bytes of heap per
      // byte of text; the escape-at-a-time one took seconds and over thirty.
      // The time bound leaves room for a worker sharing its core.
      expect(growth).toBeLessThan(8 * TEXT.length);
      expect(seconds).toBeLessThan(10);
    });
  }
});
