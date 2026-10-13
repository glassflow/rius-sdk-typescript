// Vendored from rius-semconv 00974d98c912391e241a1ff2c3d0461a2db4a043 fixtures/_recording.mjs by
// scripts/sync-semconv-fixtures.sh. Do not edit: change it in rius-semconv.
// Shared helpers for the Node recorders under fixtures/<family>/record.mjs.
//
// The Node counterpart of _recording.py, and it must write the SAME shape: the
// protobuf JSON mapping of opentelemetry.proto.trace.v1.Span (OTLP/JSON), made
// deterministic the same way, so a recording reads the same whichever language
// produced it:
//
// - ids: each distinct trace id becomes 1, 2, ... and each span id 1, 2, ...,
//   numbered in start order, so parent links survive;
// - times: every timestamp in the scenario (span starts and ends, event times)
//   is replaced by its rank in the scenario's timeline, one millisecond apart
//   from a fixed base;
// - an exception event's stack trace is elided, and a status message or an
//   exception.message is cut at the first stack frame (LangChain JS appends
//   the error's stack, with machine paths, to both);
// - every UUID in a string value becomes a placeholder numbered by first
//   appearance.
//
// Attribute values follow the OTLP JSON mapping as the OpenTelemetry JS
// exporters encode it: a JavaScript number is an intValue (a decimal string)
// when Number.isInteger, a doubleValue otherwise. An unset status is {}.
//
// Imports nothing from node_modules: it reads the finished spans' public
// fields, which every @opentelemetry/sdk-trace-base 2.x ReadableSpan has.

import { readFileSync, writeFileSync } from "node:fs";

const BASE_TIME_NS = 1_700_000_000_000_000_000n;
const TICK_NS = 1_000_000n;
const STACKTRACE = "exception.stacktrace";
const ELIDED = "<stacktrace elided>";
// Where a Node stack trace starts: its first frame. LangChain JS appends the
// error's whole stack to the status message and to exception.message.
const STACK_FRAME = "\n    at ";
const EXCEPTION_MESSAGE = "exception.message";

function cutStack(text) {
  const at = text.indexOf(STACK_FRAME);
  return at === -1 ? text : text.slice(0, at).trimEnd();
}
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const KINDS = ["SPAN_KIND_INTERNAL", "SPAN_KIND_SERVER", "SPAN_KIND_CLIENT", "SPAN_KIND_PRODUCER", "SPAN_KIND_CONSUMER"];
const STATUS = ["STATUS_CODE_UNSET", "STATUS_CODE_OK", "STATUS_CODE_ERROR"];

const hex = (value, width) => value.toString(16).padStart(width, "0");
const hrToNs = ([seconds, nanos]) => BigInt(seconds) * 1_000_000_000n + BigInt(nanos);
const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

export function anyValue(value) {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(anyValue) } };
  throw new Error(`unsupported attribute value: ${JSON.stringify(value)}`);
}

export function attributesJson(attributes) {
  return Object.entries(attributes ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({ key, value: anyValue(value) }))
    .sort(byKey);
}

/** Lexicographic comparison of two arrays of numbers or BigInts. */
function compare(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

/** Each span's depth below the scenario's roots (0 for a root), by span id. */
function depths(spans) {
  const parentOf = new Map(spans.map((s) => [s.spanContext().spanId, parentSpanId(s)]));
  const depth = new Map();
  const of = (id) => {
    if (!depth.has(id)) {
      const parent = parentOf.get(id);
      depth.set(id, parent && parentOf.has(parent) ? of(parent) + 1 : 0);
    }
    return depth.get(id);
  };
  for (const id of parentOf.keys()) of(id);
  return depth;
}

function parentSpanId(span) {
  // sdk-trace-base 2.x: parentSpanContext; 1.x: parentSpanId.
  return span.parentSpanContext?.spanId ?? span.parentSpanId;
}

/**
 * One scenario: its resource and its spans, in start order.
 *
 * With `canonicalize` (recording, the default), ids and times are renumbered
 * as described above and UUIDs scrubbed. Without it (writing an expected
 * result from replayed spans), the spans' own ids and times are kept: they are
 * already canonical, and renumbering would shift later times whenever
 * normalization drops an event.
 */
export function scenarioJson(name, spans, { canonicalize = true } = {}) {
  if (spans.length === 0) return { scenario: name, resource: { attributes: [] }, spans: [] };
  const depth = depths(spans);
  // Start order; on a tie a parent before its child, then finish order. Same
  // rule as _recording.py: millisecond-resolution clocks (LangChain's run
  // records) tie often, and a tie must not decide the numbering by chance.
  const ordered = spans
    .map((span, index) => ({ span, index }))
    .sort((a, b) =>
      compare(
        [hrToNs(a.span.startTime), depth.get(a.span.spanContext().spanId), a.index],
        [hrToNs(b.span.startTime), depth.get(b.span.spanContext().spanId), b.index],
      ),
    )
    .map(({ span }) => span);

  const traceIds = new Map();
  const spanIds = new Map();
  for (const span of ordered) {
    const { traceId, spanId } = span.spanContext();
    if (!canonicalize) {
      traceIds.set(traceId, traceId);
      spanIds.set(spanId, spanId);
      continue;
    }
    if (!traceIds.has(traceId)) traceIds.set(traceId, hex(traceIds.size + 1, 32));
    if (!spanIds.has(spanId)) spanIds.set(spanId, hex(spanIds.size + 1, 16));
  }

  // Every start, event and end is its own point; ties broken as in
  // _recording.py: start < event < end, parent starts first, child ends first.
  const points = [];
  ordered.forEach((span, i) => {
    const d = depth.get(span.spanContext().spanId);
    points.push({ key: [hrToNs(span.startTime), 0, d, i, 0], id: `start:${i}` });
    span.events.forEach((event, k) => {
      points.push({ key: [hrToNs(event.time), 1, d, i, k], id: `event:${i}:${k}` });
    });
    points.push({ key: [hrToNs(span.endTime), 2, -d, i, 0], id: `end:${i}` });
  });
  points.sort((a, b) => compare(a.key, b.key));
  const rank = new Map(
    points.map((p, n) => [p.id, String(canonicalize ? BASE_TIME_NS + BigInt(n) * TICK_NS : p.key[0])]),
  );

  const out = ordered.map((span, i) => {
    const { traceId, spanId } = span.spanContext();
    const d = { traceId: traceIds.get(traceId), spanId: spanIds.get(spanId) };
    const parent = parentSpanId(span);
    if (parent && spanIds.has(parent)) d.parentSpanId = spanIds.get(parent);
    d.name = span.name;
    d.kind = KINDS[span.kind];
    d.startTimeUnixNano = rank.get(`start:${i}`);
    d.endTimeUnixNano = rank.get(`end:${i}`);
    // Always present, even empty: _recording.py writes it that way.
    d.attributes = attributesJson(span.attributes);
    if (span.events.length) {
      d.events = span.events.map((event, k) => {
        const e = { timeUnixNano: rank.get(`event:${i}:${k}`), name: event.name };
        const eventAttributes = attributesJson(event.attributes).map((a) => {
          if (a.key === STACKTRACE) return { key: a.key, value: { stringValue: ELIDED } };
          if (a.key === EXCEPTION_MESSAGE && typeof a.value.stringValue === "string") {
            return { key: a.key, value: { stringValue: cutStack(a.value.stringValue) } };
          }
          return a;
        });
        e.attributes = eventAttributes;
        return e;
      });
    }
    const status = {};
    if (span.status?.code) status.code = STATUS[span.status.code];
    if (span.status?.message) status.message = cutStack(span.status.message);
    d.status = status;
    const scope = span.instrumentationScope ?? span.instrumentationLibrary;
    return { scope: { name: scope.name, version: scope.version ?? "" }, span: d };
  });

  const resource = { attributes: attributesJson(ordered[0].resource.attributes) };
  const scenario = { scenario: name, resource, spans: out };
  return canonicalize ? scrubUuids(scenario) : scenario;
}

function scrubUuids(scenario) {
  const seen = new Map();
  const placeholder = (match) => {
    const found = match.toLowerCase();
    if (!seen.has(found)) seen.set(found, `00000000-0000-0000-0000-${String(seen.size + 1).padStart(12, "0")}`);
    return seen.get(found);
  };
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return typeof value === "string" ? value.replace(UUID, placeholder) : value;
  };
  return walk(scenario);
}

/**
 * Replace Date.now() and performance.now() with clocks that advance one
 * millisecond per reading, so the timeline depends only on the order things
 * happened in. Call it before anything starts timing.
 *
 * Needed where an instrumentor mixes clocks: LangChain stamps its run records
 * with Date.now() (milliseconds) while OpenTelemetry reads performance.now(),
 * so which of two close moments came first changes from run to run with the
 * rounding. The sequential order of the readings does not.
 */
export function deterministicClock() {
  let ticks = 0;
  const next = () => {
    ticks += 1;
    return ticks;
  };
  const epoch = 1_700_000_000_000;
  Date.now = () => epoch + next();
  // OpenTelemetry's hrTime() is performance.timeOrigin + performance.now().
  Object.defineProperty(globalThis.performance, "timeOrigin", { value: epoch, configurable: true });
  globalThis.performance.now = () => next();
}

/** The resource attributes every recorder's provider uses (instance id pinned). */
export const RECORDER_RESOURCE = {
  "service.name": "rius-recorder",
  "service.instance.id": "recorder",
};

/**
 * A scripted provider for clients that take a `fetch`: canned responses per
 * URL, each answering exactly one request in order. A scenario fails if a
 * request is unscripted or a response is left unused.
 */
export class ScriptedProvider {
  constructor() {
    this.responses = new Map();
  }

  answer(url, ...responses) {
    this.responses.set(url, [...(this.responses.get(url) ?? []), ...responses]);
  }

  reset() {
    this.responses.clear();
  }

  leftover() {
    return Object.fromEntries([...this.responses].filter(([, q]) => q.length).map(([u, q]) => [u, q.length]));
  }

  /** A fetch that answers from the script. Never touches the network. */
  get fetch() {
    return async (input) => {
      const url = String(input instanceof Request ? input.url : input).split("?")[0];
      const queue = this.responses.get(url);
      if (!queue?.length) throw new Error(`unscripted request: ${url}`);
      const { status, body, headers } = queue.shift();
      return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: headers ?? { "content-type": "application/json" },
      });
    };
  }
}

/** A JSON response. */
export const json = (body, status = 200) => ({ status, body });

/** A server-sent-events response. Each item is [event name or null, data]. */
export function sse(events) {
  const body = events
    .map(([name, data]) => `${name ? `event: ${name}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`)
    .join("");
  return { status: 200, body, headers: { "content-type": "text/event-stream" } };
}

/**
 * The pins a recording was made with, read from the family's own node_modules.
 * Read as files, not required: several packages do not export package.json.
 */
export function environment(packages, from) {
  const version = (p) =>
    JSON.parse(readFileSync(new URL(`./node_modules/${p}/package.json`, from), "utf8")).version;
  return {
    node: process.versions.node,
    packages: Object.fromEntries(packages.map((p) => [p, version(p)])),
  };
}

/**
 * Run every scenario, write the recording, and report the environment.
 * `argv` is [<recording.json>, <environment.json>?].
 */
export async function recordAll(scenarios, exporter, script, packages, from, argv, flush) {
  const recordings = [];
  for (const [name, run] of Object.entries(scenarios)) {
    exporter.reset();
    script.reset();
    await run();
    await flush?.();
    const left = script.leftover();
    if (Object.keys(left).length) throw new Error(`${name}: scripted responses never requested: ${JSON.stringify(left)}`);
    recordings.push(scenarioJson(name, exporter.getFinishedSpans()));
  }
  writeFileSync(argv[0], `${JSON.stringify({ recordings }, null, 2)}\n`);
  const env = JSON.stringify(environment(packages, from), null, 2);
  if (argv[1]) writeFileSync(argv[1], `${env}\n`);
  else console.log(env);
}
