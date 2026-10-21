import { randomBytes } from "node:crypto";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { init, type RiusClient } from "../src/client.js";
import { contextSizes, textContents } from "../src/contextSizes.js";
import { startGeneration } from "../src/generation.js";
import {
  base64Size,
  DATA_URL_PATTERN,
  dataUrlBlob,
  recordSplits,
  splitMedia,
  stripRawPayload,
  type TextSplit,
} from "../src/mediaParts.js";
import { normalizeMessages } from "../src/messages.js";
import { toAttributeValue } from "../src/serde.js";
import { contextSizes as mainContextSizes } from "./fixtures/main/contextSizes.js";
import {
  base64Size as mainBase64Size,
  dataUrlBlob as mainDataUrlBlob,
  splitMedia as mainSplitMedia,
  stripRawPayload as mainStripRawPayload,
} from "./fixtures/main/mediaParts.js";

// --- main's strip and sizes, snapshotted ---------------------------------------------
//
// tests/fixtures/main holds mediaParts.ts and contextSizes.ts exactly as they
// were before the data-URL size and the reused splits, so each case compares
// that code, not a re-implementation of it, against the current source.

// --- generated inputs -------------------------------------------------------------

/** mulberry32: a seeded generator, so a failure replays. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ALPHABETS = {
  standard: `${ALNUM}+/`,
  urlSafe: `${ALNUM}-_`,
  mixed: `${ALNUM}+/-_`,
  alnum: ALNUM,
};

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function chars(rng: () => number, alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}

/** A base64 run: either alphabet or both, padded or not, any length, wrapped or invalid. */
function base64Run(rng: () => number): string {
  const roll = rng();
  if (roll < 0.05) {
    const bytes = randomBytes(Math.floor(rng() * 4096));
    return bytes.toString(rng() < 0.5 ? "base64" : "base64url");
  }
  const alphabet = ALPHABETS[pick(rng, ["standard", "urlSafe", "mixed", "alnum"] as const)];
  const length = rng() < 0.6 ? 4 * Math.floor(rng() * 12) : Math.floor(rng() * 48);
  let run = chars(rng, alphabet, length);
  const pad = pick(rng, [0, 0, 1, 2, 3]);
  if (pad > 0) run = run.slice(0, Math.max(0, run.length - pad)) + "=".repeat(pad);
  if (rng() < 0.15) {
    // Wrapped: a line break or space mid-run.
    const at = Math.floor(rng() * (run.length + 1));
    run = run.slice(0, at) + pick(rng, ["\n", "\r\n", " ", "\t"]) + run.slice(at);
  }
  if (rng() < 0.1) {
    const at = Math.floor(rng() * (run.length + 1));
    run = run.slice(0, at) + pick(rng, ["*", ".", "%", "=", "é", '"']) + run.slice(at);
  }
  return run;
}

function dataUrl(rng: () => number): string {
  const scheme = pick(rng, ["data", "data", "DATA", "Data"]);
  const mime = pick(rng, [
    "image/png",
    "audio/wav",
    "application/pdf",
    "image",
    "",
    "x/y+z",
    "a b/c",
  ]);
  const params = pick(rng, ["", "", ";charset=utf-8", ";name=a.png", ";a;b"]);
  const encoding = pick(rng, [";base64,", ";base64,", ";base64,", ",", ";BASE64,"]);
  return `${scheme}:${mime}${params}${encoding}${base64Run(rng)}`;
}

/** Prose and data URLs, never a JSON candidate (it starts with a letter). */
function text(rng: () => number): string {
  let out = pick(rng, ["see", "Here", "héllo", "x"]);
  const pieces = Math.floor(rng() * 4);
  for (let i = 0; i < pieces; i++) {
    out += pick(rng, [" ", "\n", "(", '"', "→ ", "🙂"]);
    out += rng() < 0.7 ? dataUrl(rng) : chars(rng, ALNUM, Math.floor(rng() * 20));
  }
  return out;
}

/** A JSON candidate holding data URLs in its strings, for the walk. */
function candidate(rng: () => number): string {
  return JSON.stringify({ note: text(rng), items: [text(rng), { caption: text(rng) }] });
}

function messages(rng: () => number): Array<{ role: string; parts: Record<string, unknown>[] }> {
  return Array.from({ length: 1 + Math.floor(rng() * 4) }, () => ({
    role: pick(rng, ["user", "assistant", "system", "tool"]),
    parts: Array.from({ length: 1 + Math.floor(rng() * 3) }, () =>
      rng() < 0.8
        ? { type: "text", content: rng() < 0.85 ? text(rng) : candidate(rng) }
        : { type: "blob", modality: "image", byte_size: 3 },
    ),
  }));
}

// --- the differential ---------------------------------------------------------------

describe("the data-URL strip against main", () => {
  it("sizes every base64 run as the old base64Size did", () => {
    const rng = generator(1);
    for (let i = 0; i < 5000; i++) {
      const run = base64Run(rng);
      expect(base64Size(run)).toBe(mainBase64Size(run));
      // The run as the pattern matched it: whole, or cut at its first invalid character.
      const url = `data:image/png;base64,${run}`;
      const matched = new RegExp(DATA_URL_PATTERN).exec(url)?.[3];
      expect(splitMedia(url).tokens[0].byteSize).toBe(mainBase64Size(matched ?? ""));
      expect(dataUrlBlob(url, "image")).toEqual(mainDataUrlBlob(url, "image"));
    }
  });

  it("strips and splits text as the old strip did", () => {
    const rng = generator(2);
    for (let i = 0; i < 5000; i++) {
      const value = text(rng);
      expect(stripRawPayload(value)).toBe(mainStripRawPayload(value));
      expect(splitMedia(value)).toEqual(mainSplitMedia(value));
    }
  });

  it("strips the strings of a JSON document as the old strip did", () => {
    const rng = generator(3);
    for (let i = 0; i < 2000; i++) {
      const document = JSON.parse(candidate(rng));
      const raw = JSON.stringify(document);
      expect(stripRawPayload(raw)).toBe(mainStripRawPayload(raw));
    }
  });

  it("records, while serializing, the split the sizes would compute", () => {
    const rng = generator(4);
    for (let i = 0; i < 2000; i++) {
      const msgs = messages(rng);
      const splits = new Map<string, TextSplit | undefined>(
        textContents(msgs).map((content) => [content, undefined]),
      );
      recordSplits(splits, () => toAttributeValue(msgs));
      for (const [content, split] of splits) {
        // Every text that is no JSON candidate was stripped once, and recorded.
        if (/^[ \t\n\r]*[{[]/.test(content)) expect(split).toBeUndefined();
        else expect(split).toEqual(splitMedia(content));
      }
      expect(contextSizes(undefined, msgs, undefined, (t) => splits.get(t))).toBe(
        mainContextSizes(undefined, msgs, undefined),
      );
    }
  });
});

describe("a split the serialization does not record", () => {
  it("is a JSON candidate's, which may parse at depth 0 and not as deep as the messages", () => {
    // Too deep to parse inside the messages, so rule (b) reads its raw text,
    // `image\/png` and all; split alone, it parses and its mime is image/png.
    const content = `${"[".repeat(62)}"data:image\\/png;base64,AAAA"${"]".repeat(62)}`;
    const msgs = [{ role: "user", parts: [{ type: "text", content }] }];
    const splits = new Map<string, TextSplit | undefined>([[content, undefined]]);
    recordSplits(splits, () => toAttributeValue(msgs));
    expect(splits.get(content)).toBeUndefined();
    expect(splitMedia(content).tokens).toEqual([{ rule: "b", mime: "image/png", byteSize: 3 }]);
  });
});

describe("rius.context.sizes with the reused splits", () => {
  let exporter: InMemorySpanExporter;
  let client: RiusClient | undefined;
  afterEach(async () => {
    await client?.shutdown();
    client = undefined;
  });

  it("is what the old code wrote, for every generated generation", async () => {
    exporter = new InMemorySpanExporter();
    client = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
    const rng = generator(5);
    const expected: string[] = [];
    for (let i = 0; i < 500; i++) {
      const input = messages(rng).map(({ role, parts }) => ({
        role,
        content: parts.map((part) =>
          part.type === "text" ? { type: "text", text: part.content } : { type: "text", text: "x" },
        ),
      }));
      const output = rng() < 0.5 ? text(rng) : undefined;
      const generation = startGeneration("chat", { model: "m", input });
      if (output !== undefined) generation.setOutput(output);
      generation.end();
      expected.push(
        mainContextSizes(
          undefined,
          normalizeMessages(input, "user"),
          output === undefined ? undefined : normalizeMessages(output, "assistant"),
        ),
      );
    }
    await client.flush();
    const written = exporter.getFinishedSpans().map((s) => s.attributes["rius.context.sizes"]);
    expect(written).toEqual(expected);
  });
});
