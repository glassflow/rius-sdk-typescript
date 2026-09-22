import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contextSizes } from "../src/contextSizes.js";
import { normalizeMessages } from "../src/messages.js";
import input from "./fixtures/context_sizes_input.json" with { type: "json" };

/**
 * Cross-SDK parity: the Python SDK runs the same fixture through its
 * normalizer and sizes function and commits its output too. The two expected
 * files are diffed by hand; if they differ one implementation is wrong. On the
 * first run this writes the expected file, afterwards it asserts against it.
 */
const EXPECTED = new URL("./fixtures/context_sizes_expected.json", import.meta.url);

describe("rius.context.sizes parity fixture", () => {
  it("matches the committed expected output byte for byte", () => {
    const actual = contextSizes(
      input.tools,
      normalizeMessages(input.input, "user"),
      normalizeMessages(input.output, "assistant"),
    );
    if (!existsSync(EXPECTED)) writeFileSync(EXPECTED, actual);
    expect(actual).toBe(readFileSync(EXPECTED, "utf8"));
  });
});
