// The strip and the rebuild read a JSON string by position: scanString checks
// it and finds its end, JSON.parse decodes it whole when it holds an escape,
// and stringEscapes maps its escapes back to the raw text only when an edit
// lands in it. Together they must give exactly what the escape-at-a-time
// decoder they replaced gave (frozen below), for every input: the same
// strings accepted, the same end, the same decoded value and the same escapes.

import { describe, expect, it } from "vitest";
import { scanString, stringEscapes } from "../src/mediaParts.js";

class Rejected extends Error {}

const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function plainHex4(text: string, at: number): number {
  const digits = text.slice(at, at + 4);
  if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw new Rejected();
  return Number.parseInt(digits, 16);
}

/** The decoder as it was: its decoded value, escapes and end. */
function plainString(text: string, from: number): { out: string; escapes: number[]; end: number } {
  let i = from;
  if (text[i] !== '"') throw new Rejected();
  i++;
  let out = "";
  const escapes: number[] = [];
  let run = i;
  for (;;) {
    if (i >= text.length) throw new Rejected();
    const ch = text[i];
    if (ch === '"') break;
    if (ch < " ") throw new Rejected();
    if (ch !== "\\") {
      i++;
      continue;
    }
    const at = i;
    const kind = text.slice(at + 1, at + 2);
    let decoded: string;
    if (Object.hasOwn(SHORT_ESCAPES, kind)) {
      decoded = SHORT_ESCAPES[kind];
      i += 2;
    } else if (kind === "u") {
      const code = plainHex4(text, at + 2);
      i += 6;
      decoded = String.fromCharCode(code);
      if (code >= 0xd800 && code < 0xdc00 && text.startsWith("\\u", i)) {
        const low = plainHex4(text, i + 2);
        if (low >= 0xdc00 && low < 0xe000) {
          i += 6;
          decoded = String.fromCharCode(code, low);
        }
      }
    } else {
      throw new Rejected();
    }
    out += text.slice(run, at);
    for (let unit = 0; unit < decoded.length; unit++) escapes.push(out.length + unit, at, i);
    out += decoded;
    run = i;
  }
  out += text.slice(run, i);
  return { out, escapes, end: i + 1 };
}

const PIECES = [
  "a",
  "ab",
  "é",
  "😀",
  "\ud800",
  "\udfff",
  "\x01",
  "\x7f",
  "\\n",
  "\\t",
  '\\"',
  "\\\\",
  "\\/",
  "\\b",
  "\\f",
  "\\r",
  "\\u0041",
  "\\u00e9",
  "\\uD83D\\uDE00",
  "\\ud83d\\ude00",
  "\\ud800",
  "\\udfff",
  "\\ud800\\u0041",
  "\\ud800\\ud800",
  "\\ud800\\u12",
  "\\ud800\\uZZZZ",
  "\\ud800\\",
  "\\u12",
  "\\u12G4",
  "\\x",
  "\\",
  '"',
  "data:image/png;base64,AAAA",
];

/** A small deterministic generator, so a failure replays. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x80000000;
  };
}

function literal(next: () => number): string {
  let body = "";
  const n = Math.floor(next() * 8);
  for (let k = 0; k < n; k++) body += PIECES[Math.floor(next() * PIECES.length)];
  const close = next() < 0.95 ? '"' : "";
  return `"${body}${close}${next() < 0.3 ? ',"x"]' : ""}`;
}

type Outcome =
  | { rejected: true }
  | { rejected: false; end: number; value: string; escapes: number[] };

function plainOutcome(text: string): Outcome {
  try {
    const { out, escapes, end } = plainString(text, 0);
    return { rejected: false, end, value: out, escapes };
  } catch (error) {
    if (error instanceof Rejected) return { rejected: true };
    throw error;
  }
}

function liveOutcome(text: string): Outcome {
  let scanned: { end: number; escaped: boolean };
  try {
    scanned = scanString(text, 0);
  } catch (error) {
    if (error instanceof Error && error.constructor.name === "NotJson") return { rejected: true };
    throw error;
  }
  const { end, escaped } = scanned;
  const value = escaped ? (JSON.parse(text.slice(0, end)) as string) : text.slice(1, end - 1);
  return { rejected: false, end, value, escapes: stringEscapes(text, 0) };
}

describe("reading a JSON string by position", () => {
  it("matches the escape-at-a-time decoder on generated strings", () => {
    const next = random(1888);
    let accepted = 0;
    for (let n = 0; n < 50_000; n++) {
      const text = literal(next);
      const plain = plainOutcome(text);
      expect(liveOutcome(text), text).toEqual(plain);
      if (!plain.rejected) accepted++;
    }
    // The generator reaches both outcomes, not only broken strings.
    expect(accepted).toBeGreaterThan(5_000);
    expect(accepted).toBeLessThan(45_000);
  });

  it("finds no escape in a string that has none", () => {
    expect(scanString('"plain é 😀"', 0)).toEqual({ end: 12, escaped: false });
    expect(stringEscapes('"plain"', 0)).toEqual([]);
  });

  it("rejects a string the text ends inside, instead of reading past the end", () => {
    for (const text of ['"', '"abc', '"a\\n', '"\\ud83d\\ude00']) {
      expect(() => stringEscapes(text, 0), text).toThrow(
        expect.objectContaining({ constructor: expect.objectContaining({ name: "NotJson" }) }),
      );
    }
  });
});
