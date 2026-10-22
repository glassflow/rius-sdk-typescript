// The message-key rebuild and the raw-payload strip called at the bottom of a
// deep recursion, before anything in this process has run their code: vitest
// runs each file in its own process. Cold, the parsers' frames are large, so
// a candidate the strip parses at 64 levels runs out of stack well before its
// rule (b) fallback does. And V8 throws a SyntaxError, not a RangeError, when
// it compiles a regular expression with no stack left; it then keeps the
// compiled regex for every later use of the same source, so only a first use
// meets it.

import { describe, expect, it } from "vitest";
import { rebuildNativeMediaParts, strip } from "../src/mediaParts.js";
import { afterFirstReturn, upFromStackBottom } from "./stack.js";

describe("with the stack nearly used up", () => {
  it("the rebuild leaves a message key as it came, even compiling its first regex", () => {
    const part = '{"type": "blob", "content": "QUJD", "mime_type": "image/png"}';
    const value = `[{"role": "user", "parts": [${part}]}]`;
    const results = upFromStackBottom(() => rebuildNativeMediaParts(value, true));
    // Only entering the rebuild can overflow, as a RangeError.
    expect(results.filter((r) => r instanceof SyntaxError)).toEqual([]);
    const returned = afterFirstReturn(results);
    expect(returned).toContain(value);
    expect(returned.at(-1)).not.toBe(value);
  });

  it("the strip applies rule (b) alone to a candidate it cannot parse, never throwing", () => {
    // 64 levels, the most the strip parses. Rule (e) needs the parse; rule
    // (b) still finds the data URL beside it.
    const inner = '{"mediaType":"image/png","data":"QUFB","u":"data:image/png;base64,QUFB"}';
    const candidate = `${"[".repeat(63)}${inner}${"]".repeat(63)}`;
    const parsed = candidate
      .replace('"QUFB"', '"[stripped image/png 3 bytes]"')
      .replace("data:image/png;base64,QUFB", "[stripped image/png 3 bytes]");
    const ruleB = candidate.replace("data:image/png;base64,QUFB", "[stripped image/png 3 bytes]");
    // Parsed, but the walk's frames left rule (b)'s regex no stack: it fails
    // closed, the rest of its piece (here the whole string) replaced, size unknown.
    const closed = parsed.replace(
      '"u":"[stripped image/png 3 bytes]"',
      '"u":"[stripped image/png unknown bytes]"',
    );
    const results = afterFirstReturn(upFromStackBottom(() => strip(candidate)));
    const texts = new Set(results.map((r) => r.text));
    expect(texts).toContain(ruleB);
    expect(texts).toContain(parsed);
    expect([...texts].filter((t) => ![ruleB, parsed, closed].includes(t))).toEqual([]);
    expect(results.at(-1)?.text).toBe(parsed);
    for (const result of results) {
      expect(result.tokens.map((t) => t.rule)).toEqual(result.text === ruleB ? ["b"] : ["e", "b"]);
    }
  });
});
