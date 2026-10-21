// Every shared recording, normalized by this SDK, must equal its expected result.
//
// The recordings and their expected results come from rius-semconv (synced by
// scripts/sync-semconv-fixtures.sh into tests/fixtures/semconv). Each recording is
// real instrumentor output; its expected result is what the reference normalizer
// produced from it: the Python SDK for the families both SDKs cover, this SDK for
// the Vercel AI SDK families only it covers.
//
// Each scenario is replayed through a real tracer, so the processors see a span
// start and end as they do live: an id generator hands out the recorded ids, the
// chain is the SDK's own (the Vercel ai.* transform, then the normalizer), and a
// family the manifest marks `replay.aggregating_producer` is started through
// aggregatingTracer, as the SDK starts @ai-sdk/otel's spans. Where this SDK and
// the reference differ, the difference must be reviewed in
// tests/conformance/known_differences.json; one that is not listed fails, and so
// does a listed one that no longer occurs.
//
// Values are compared as values: an OTLP intValue and a doubleValue holding the
// same number are equal. JavaScript cannot tell 1 from 1.0, so the encoder writes
// an integer-valued double as an intValue where the Python encoder writes a
// doubleValue; that is a difference of encoding, not of normalization.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT_CONTEXT, type Tracer, trace } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { aggregatingTracer } from "../src/aggregatedUsage.js";
import { REGISTRY } from "../src/instrumentation.js";
import { NormalizingSpanProcessor } from "../src/normalize.js";
import { type ScenarioJson, scenarioJson } from "./conformance/_recording.mjs";
import { MESSAGE_KEYS, mediaPartsIn, nonCanonical } from "./mediaContract.js";

// fileURLToPath, not import.meta.dirname: that needs Node 20.11, and CI runs 18.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures/semconv/fixtures");
const KNOWN = join(HERE, "conformance/known_differences.json");

type AnyValue = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
  arrayValue?: { values?: AnyValue[] };
};
type KeyValue = { key: string; value: AnyValue };
type SpanJson = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: KeyValue[];
  events?: { timeUnixNano: string; name: string; attributes?: KeyValue[] }[];
  status?: { code?: string; message?: string };
};
type Scenario = {
  scenario: string;
  resource?: { attributes?: KeyValue[] };
  spans: { scope: { name: string; version?: string }; span: SpanJson }[];
};
type Manifest = {
  family: string;
  recordings: Record<
    string,
    { expected: { file: string }; replay?: { aggregating_producer?: boolean } }
  >;
};
type Recording = {
  family: string;
  aggregating: boolean;
  raw: Scenario[];
  expected: Scenario[];
};

const KINDS: Record<string, number> = {
  SPAN_KIND_INTERNAL: 0,
  SPAN_KIND_SERVER: 1,
  SPAN_KIND_CLIENT: 2,
  SPAN_KIND_PRODUCER: 3,
  SPAN_KIND_CONSUMER: 4,
};
const STATUS: Record<string, number> = {
  STATUS_CODE_UNSET: 0,
  STATUS_CODE_OK: 1,
  STATUS_CODE_ERROR: 2,
};

function value(v: AnyValue): unknown {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.arrayValue !== undefined) return (v.arrayValue.values ?? []).map(value);
  throw new Error(`unsupported attribute value: ${JSON.stringify(v)}`);
}

const attrs = (items: KeyValue[] = []) =>
  Object.fromEntries(items.map((a) => [a.key, value(a.value)])) as Record<string, never>;

const hr = (ns: string): [number, number] => {
  const n = BigInt(ns);
  return [Number(n / 1_000_000_000n), Number(n % 1_000_000_000n)];
};

function loadRecordings(): Recording[] {
  const out: Recording[] = [];
  for (const family of readdirSync(FIXTURES, { withFileTypes: true })) {
    if (!family.isDirectory()) continue;
    const dir = join(FIXTURES, family.name);
    const manifest: Manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    for (const [file, entry] of Object.entries(manifest.recordings)) {
      // A sink-only family's expected result is a stored row, not spans.
      if (!entry.expected.file.endsWith(".expected.json")) continue;
      out.push({
        family: manifest.family,
        aggregating: Boolean(entry.replay?.aggregating_producer),
        raw: JSON.parse(readFileSync(join(dir, file), "utf8")).recordings,
        expected: JSON.parse(readFileSync(join(dir, entry.expected.file), "utf8")).recordings,
      });
    }
  }
  return out;
}

/** Hands out the recorded ids, in the order the tracer asks for them. */
class ReplayIds {
  traceIds: string[] = [];
  spanIds: string[] = [];
  generateTraceId = () => this.traceIds.shift() as string;
  generateSpanId = () => this.spanIds.shift() as string;
}

async function replay(scenario: Scenario, aggregating: boolean): Promise<ScenarioJson> {
  const ids = new ReplayIds();
  const sink = new InMemorySpanExporter();
  const vercelEntry = REGISTRY.find((entry) => entry.name === "vercel-ai");
  const vercel = (await vercelEntry?.load()) as SpanProcessor | undefined;
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes(attrs(scenario.resource?.attributes)),
    idGenerator: ids,
    spanProcessors: [
      ...(vercel ? [vercel] : []),
      new NormalizingSpanProcessor(),
      new SimpleSpanProcessor(sink),
    ],
  });

  const live = new Map<string, Span>();
  for (const { scope, span: d } of scenario.spans) {
    // A root asks the id generator for a trace id; every span asks for a span id.
    if (!d.parentSpanId) ids.traceIds.push(d.traceId);
    ids.spanIds.push(d.spanId);
    let tracer: Tracer = provider.getTracer(scope.name, scope.version || undefined);
    if (aggregating) tracer = aggregatingTracer(tracer);
    const parent = d.parentSpanId ? live.get(d.parentSpanId) : undefined;
    const ctx = parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT;
    const span = tracer.startSpan(
      d.name,
      {
        kind: KINDS[d.kind ?? "SPAN_KIND_INTERNAL"],
        attributes: attrs(d.attributes),
        startTime: hr(d.startTimeUnixNano),
      },
      ctx,
    ) as Span;
    for (const e of d.events ?? []) span.addEvent(e.name, attrs(e.attributes), hr(e.timeUnixNano));
    const code = STATUS[d.status?.code ?? "STATUS_CODE_UNSET"] ?? 0;
    if (code) span.setStatus({ code, ...(d.status?.message ? { message: d.status.message } : {}) });
    live.set(d.spanId, span);
  }
  const byEnd = [...scenario.spans].sort((a, b) =>
    BigInt(a.span.endTimeUnixNano) < BigInt(b.span.endTimeUnixNano) ? -1 : 1,
  );
  for (const { span: d } of byEnd) live.get(d.spanId)?.end(hr(d.endTimeUnixNano));
  await provider.forceFlush();
  return scenarioJson(scenario.scenario, sink.getFinishedSpans(), { canonicalize: false });
}

type Difference = { family: string; scenario: string; spanId: string; key: string; detail: string };

const short = (v: unknown) => {
  const text = JSON.stringify(v) ?? "undefined";
  return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
};

const eventsOf = (s: SpanJson) =>
  (s.events ?? []).map((e) => ({
    name: e.name,
    time: e.timeUnixNano,
    attributes: attrs(e.attributes),
  }));

function differences(family: string, got: ScenarioJson, want: Scenario): Difference[] {
  const out: Difference[] = [];
  const produced = new Map(got.spans.map((e) => [(e.span as SpanJson).spanId, e.span as SpanJson]));
  for (const { span: expected } of want.spans) {
    const at = { family, scenario: want.scenario, spanId: expected.spanId };
    const actual = produced.get(expected.spanId);
    if (!actual) {
      out.push({ ...at, key: "span", detail: "missing" });
      continue;
    }
    const a: Record<string, unknown> = attrs(actual.attributes);
    const b: Record<string, unknown> = attrs(expected.attributes);
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
        out.push({ ...at, key, detail: `${short(b[key])} expected, ${short(a[key])} produced` });
      }
    }
    if (JSON.stringify(eventsOf(actual)) !== JSON.stringify(eventsOf(expected))) {
      out.push({ ...at, key: "events", detail: "differ" });
    }
    const statusOf = (s: SpanJson) => [s.status?.code ?? "", s.status?.message ?? ""];
    if (JSON.stringify(statusOf(actual)) !== JSON.stringify(statusOf(expected))) {
      out.push({
        ...at,
        key: "status",
        detail: `${short(expected.status)} expected, ${short(actual.status)} produced`,
      });
    }
    if (actual.name !== expected.name) out.push({ ...at, key: "name", detail: "differs" });
    if (actual.kind !== expected.kind) out.push({ ...at, key: "kind", detail: "differs" });
  }
  return out;
}

type Known = { family: string; key: string; reason: string };

describe("the shared recordings from rius-semconv", () => {
  const recordings = loadRecordings();
  const reviewed = JSON.parse(readFileSync(KNOWN, "utf8"));
  const known: Known[] = reviewed.differences;

  it("every known difference says why", () => {
    for (const k of known) expect(k.reason.trim(), `${k.family} ${k.key}`).not.toBe("");
  });

  it("normalize to their expected results, or to a reviewed difference", async () => {
    const used = new Set<string>();
    const unexpected: string[] = [];
    let spans = 0;
    for (const rec of recordings) {
      const expected = new Map(rec.expected.map((s) => [s.scenario, s]));
      for (const raw of rec.raw) {
        const want = expected.get(raw.scenario);
        if (!want) throw new Error(`${rec.family}/${raw.scenario}: no expected result`);
        spans += want.spans.length;
        for (const d of differences(rec.family, await replay(raw, rec.aggregating), want)) {
          const matches = known.filter(
            (k) => k.family === d.family && (k.key === "*" || k.key === d.key),
          );
          for (const k of matches) used.add(`${k.family} ${k.key}`);
          if (matches.length === 0) {
            unexpected.push(`${d.family}/${d.scenario} span ${d.spanId}: ${d.key}: ${d.detail}`);
          }
        }
      }
    }
    expect(spans, "no spans compared: is tests/fixtures/semconv synced?").toBeGreaterThan(0);
    expect(unexpected, "unreviewed differences").toEqual([]);
    const stale = known
      .filter((k) => !used.has(`${k.family} ${k.key}`))
      .map((k) => `${k.family} ${k.key}`);
    expect(stale, "known differences that no longer occur").toEqual([]);
  });

  it("hold no media part that is not canonical, a file without its file_id say", async () => {
    const failures: string[] = [];
    let parts = 0;
    for (const rec of recordings) {
      for (const raw of rec.raw) {
        for (const { span } of (await replay(raw, rec.aggregating)).spans) {
          const attributes = attrs((span as SpanJson).attributes);
          parts += MESSAGE_KEYS.flatMap((key) => mediaPartsIn(attributes[key])).length;
          for (const why of nonCanonical(attributes)) {
            failures.push(`${rec.family}/${raw.scenario}: ${why}`);
          }
        }
      }
    }
    expect(parts, "no media part normalized: is tests/fixtures/semconv synced?").toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });

  it("come out of a second normalization unchanged", async () => {
    // Normalized spans are normalized again in production: the sink normalizes
    // what this SDK exported. So this SDK's own output, replayed through it
    // again, must not change.
    const changed: string[] = [];
    let spans = 0;
    for (const rec of recordings) {
      for (const raw of rec.raw) {
        const once = (await replay(raw, rec.aggregating)) as unknown as Scenario;
        spans += once.spans.length;
        for (const d of differences(rec.family, await replay(once, rec.aggregating), once)) {
          changed.push(`${d.family}/${d.scenario} span ${d.spanId}: ${d.key}: ${d.detail}`);
        }
      }
    }
    expect(spans, "no spans compared: is tests/fixtures/semconv synced?").toBeGreaterThan(0);
    expect(changed, "a second normalization changed").toEqual([]);
  });

  it("keep their ids, parents and times through the replay", async () => {
    for (const rec of recordings) {
      const expected = new Map(rec.expected.map((s) => [s.scenario, s]));
      for (const raw of rec.raw) {
        const got = await replay(raw, rec.aggregating);
        const produced = new Map(
          got.spans.map((e) => [(e.span as SpanJson).spanId, e.span as SpanJson]),
        );
        for (const { span: want } of expected.get(raw.scenario)?.spans ?? []) {
          const span = produced.get(want.spanId);
          expect(span, `${rec.family}/${raw.scenario} ${want.spanId}`).toBeDefined();
          for (const field of [
            "traceId",
            "parentSpanId",
            "startTimeUnixNano",
            "endTimeUnixNano",
          ] as const) {
            expect(span?.[field], `${rec.family}/${raw.scenario} ${want.spanId} ${field}`).toBe(
              want[field],
            );
          }
        }
      }
    }
  });
});
