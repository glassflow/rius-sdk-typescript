// The heap the media rebuild and the raw-payload strip take on a large
// message: a bounded multiple of the input, never a pair of offsets per
// character. vitest.config.ts runs the workers with --expose-gc, so each
// measurement starts from a collected heap.

import { describe, expect, it } from "vitest";
import { stripRawPayload } from "../src/mediaParts.js";
import { normalizeNativeMediaParts } from "../src/normalize.js";

const MB = 1024 * 1024;
const gc = (globalThis as { gc?: () => void }).gc;

/** The heap one call grows by, the input already allocated. */
function heapGrowth(run: () => unknown): number {
  gc?.();
  const before = process.memoryUsage().heapUsed;
  const result = run();
  const growth = process.memoryUsage().heapUsed - before;
  expect(result).toBeDefined();
  return growth;
}

function plainMessages(): string {
  const prose = "The quick brown fox jumps over the lazy dog. ".repeat(Math.ceil(MB / 45));
  const content = prose.slice(0, MB);
  // Flat, so the measurement never counts flattening the input itself.
  const flat = JSON.parse(JSON.stringify(content)) as string;
  return `[{"role":"user","parts":[{"type":"text","content":"${flat}"}]}]`;
}

describe("a megabyte of plain text in a message key", () => {
  it("runs with the garbage collector exposed", () => {
    expect(gc).toBeTypeOf("function");
  });

  it("is rebuilt in under 8 bytes of heap per byte", () => {
    const messages = plainMessages();
    const attributes: Record<string, string> = { "gen_ai.input.messages": messages };
    const growth = heapGrowth(() => {
      normalizeNativeMediaParts(attributes);
      return attributes;
    });
    expect(attributes["gen_ai.input.messages"]).toBe(messages);
    expect(growth).toBeLessThan(8 * messages.length);
  });

  it("is stripped in under 8 bytes of heap per byte", () => {
    const messages = plainMessages();
    let stripped = "";
    const growth = heapGrowth(() => {
      stripped = stripRawPayload(messages);
      return stripped;
    });
    expect(stripped).toBe(messages);
    expect(growth).toBeLessThan(8 * messages.length);
  });
});
