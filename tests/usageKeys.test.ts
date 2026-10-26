// The normalizer follows the usage-key registry.
//
// tests/fixtures/semconv/usage_keys.json is rius-semconv's
// registry/usage_keys.yaml as JSON, synced by scripts/sync-semconv-fixtures.sh.
// Every row it says the TypeScript SDK maps must reach its target here, and no
// row it says is ignored may be read: the TypeScript counterpart of the Python
// SDK's test_usage_keys.py. The breakdowns the normalizer drops at 0 are
// exactly the rows it marks omit_zero.
//
// A row outside the AI SDK's ai.* namespace is a rule of NORMALIZATION_RULES
// with that target, as in Python's table. The AI SDK's usage spellings are not
// table rules (a model call maps them to gen_ai.usage.*, a wrapper to
// rius.aggregated_usage.*), so those rows are checked by normalizing a model
// call's attributes.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttributeValue } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import {
  NORMALIZATION_RULES,
  normalizeVercelSpan,
  USAGE_BREAKDOWN_SUFFIXES,
} from "../src/normalize.js";
import { GEN_AI_USAGE_PREFIX } from "../src/semconv.js";

const REGISTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "semconv",
  "usage_keys.json",
);

interface Row {
  key?: string;
  prefix?: string;
  decision: string;
  target?: string;
  mapped_by?: string[];
  omit_zero?: boolean;
}

const rows: Row[] = JSON.parse(readFileSync(REGISTRY, "utf8")).keys;

/** Each source key of a table rule with one target, and that target. */
function tableTargets(): Map<string, string> {
  const targets = new Map<string, string>();
  for (const rule of NORMALIZATION_RULES) {
    if (!("target" in rule)) continue;
    const sources = typeof rule.source === "string" ? [rule.source] : rule.source;
    for (const source of sources) if (!targets.has(source)) targets.set(source, rule.target);
  }
  return targets;
}

/** Every source key of the table, whichever shape its rule has. */
function tableSources(): Set<string> {
  const sources = new Set<string>();
  for (const rule of NORMALIZATION_RULES) {
    for (const source of typeof rule.source === "string" ? [rule.source] : rule.source) {
      sources.add(source);
    }
  }
  return sources;
}

const isVercel = (key: string) => key.startsWith("ai.");

/** A model call's attributes holding `key`, after the AI SDK normalization. */
function normalizedModelCall(key: string): Record<string, AttributeValue | undefined> {
  const attributes: Record<string, AttributeValue | undefined> = {
    "ai.operationId": "ai.generateText.doGenerate",
    [key]: 7,
  };
  normalizeVercelSpan(attributes);
  return attributes;
}

const mapped = rows.filter(
  (row): row is Row & { key: string; target: string } =>
    row.key !== undefined && row.target !== undefined && !!row.mapped_by?.includes("typescript"),
);
const ignored = rows.filter(
  (row): row is Row & { key: string } => row.key !== undefined && row.decision === "ignored",
);

describe("usage_keys.json", () => {
  it("names the TypeScript SDK (is usage_keys.json synced?)", () => {
    expect(mapped.length).toBeGreaterThan(0);
    expect(mapped.some((row) => isVercel(row.key))).toBe(true);
    expect(mapped.some((row) => !isVercel(row.key))).toBe(true);
  });

  it("every row the TypeScript SDK maps outside ai.* is a table rule with its target", () => {
    const targets = tableTargets();
    const want = mapped.filter((row) => !isVercel(row.key));
    expect(Object.fromEntries(want.map((row) => [row.key, targets.get(row.key)]))).toEqual(
      Object.fromEntries(want.map((row) => [row.key, row.target])),
    );
  });

  it("every ai.* row the TypeScript SDK maps reaches its target on a model call", () => {
    const want = mapped.filter((row) => isVercel(row.key));
    const got = Object.fromEntries(
      want.map((row) => {
        const attributes = normalizedModelCall(row.key);
        return [row.key, { target: attributes[row.target], source: attributes[row.key] }];
      }),
    );
    expect(got).toEqual(
      Object.fromEntries(want.map((row) => [row.key, { target: 7, source: undefined }])),
    );
  });

  it("no ignored row is read", () => {
    const sources = tableSources();
    expect(ignored.filter((row) => sources.has(row.key)).map((row) => row.key)).toEqual([]);
    const moved = ignored
      .filter((row) => isVercel(row.key))
      .filter((row) => normalizedModelCall(row.key)[row.key] !== 7)
      .map((row) => row.key);
    expect(moved).toEqual([]);
  });
});

describe("the zero-dropped usage breakdowns", () => {
  it("are the rows marked omit_zero", () => {
    const omitted = rows.filter((row) => row.omit_zero === true).map((row) => row.key);
    expect(
      omitted.length,
      "no row is marked omit_zero: is usage_keys.json synced?",
    ).toBeGreaterThan(0);
    expect(USAGE_BREAKDOWN_SUFFIXES.map((suffix) => GEN_AI_USAGE_PREFIX + suffix).sort()).toEqual(
      [...omitted].sort(),
    );
  });
});
