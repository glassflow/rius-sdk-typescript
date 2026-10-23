// This SDK against rius-semconv's shared SDK cases.
//
// tests/fixtures/semconv/sdk_cases is rius-semconv's sdk_cases/, synced by
// scripts/sync-semconv-fixtures.sh. The Python SDK runs the same cases, so both
// SDKs are held to one expected result for each: how input.value and
// output.value are written, how setAttribute encodes a value, how messages and
// rius.context.sizes are recorded, what the masking exporter keeps, how RIUS_*
// variables resolve, how the resource takes in OTEL_RESOURCE_ATTRIBUTES and
// how the error on the Anthropic SDK's own spans is named.
// Their README describes the format, including the tagged values JSON cannot
// hold ({"$bytes": N}, {"$number": "NaN"}).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type InitOptions, init, type RiusClient } from "../src/client.js";
import { type Mask, type ResolvedConfig, resolveConfig } from "../src/config.js";
import { startGeneration } from "../src/generation.js";
import { MaskingSpanExporter } from "../src/masking.js";
import { startSpan } from "../src/spans.js";

const CASES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "semconv", "sdk_cases");

// biome-ignore lint/suspicious/noExplicitAny: each case file has its own shape, read as JSON.
type Case = Record<string, any> & { name: string };

function cases(file: string): Case[] {
  const all = JSON.parse(readFileSync(join(CASES, `${file}.json`), "utf8")).cases as Case[];
  if (all.length === 0) throw new Error(`no cases in ${file}.json: is sdk_cases synced?`);
  return all;
}

/** A case's value with its tagged forms decoded. */
function value(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(value);
  if (raw !== null && typeof raw === "object") {
    const keys = Object.keys(raw);
    const record = raw as Record<string, unknown>;
    if (keys.length === 1 && keys[0] === "$bytes") return new Uint8Array(record.$bytes as number);
    if (keys.length === 1 && keys[0] === "$number") return Number(record.$number);
    return Object.fromEntries(keys.map((key) => [key, value(record[key])]));
  }
  return raw;
}

let client: RiusClient | undefined;

afterEach(async () => {
  await client?.shutdown();
  client = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Unset every RIUS_* variable and OTEL_RESOURCE_ATTRIBUTES for this test. */
function clearRiusEnv(): void {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("RIUS_") || name === "OTEL_RESOURCE_ATTRIBUTES") {
      vi.stubEnv(name, undefined);
    }
  }
}

async function onlySpanAttributes(
  exporter: InMemorySpanExporter,
  record: () => void,
  options: InitOptions = { serviceName: "svc" },
) {
  client = init({ spanExporter: exporter, heartbeat: false, ...options });
  record();
  await client.flush();
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(1);
  return spans[0];
}

describe("values.json: input.value and output.value", () => {
  for (const c of cases("values")) {
    it(c.name, async () => {
      const span = await onlySpanAttributes(new InMemorySpanExporter(), () => {
        startSpan("s").setInput(value(c.value)).setOutput(value(c.value)).end();
      });
      expect(span.attributes["input.value"]).toBe(c.expected);
      expect(span.attributes["output.value"]).toBe(c.expected);
    });
  }
});

describe("attributes.json: setAttribute", () => {
  for (const c of cases("attributes")) {
    it(c.name, async () => {
      const span = await onlySpanAttributes(new InMemorySpanExporter(), () => {
        // The cases are what callers pass, any JSON shape and byte objects.
        startSpan("s")
          .setAttribute("k", value(c.value) as never)
          .end();
      });
      expect(span.attributes.k).toEqual(c.expected);
    });
  }
});

describe("messages.json: generation messages and rius.context.sizes", () => {
  for (const c of cases("messages")) {
    it(c.name, async () => {
      const span = await onlySpanAttributes(new InMemorySpanExporter(), () => {
        const generation = startGeneration({ model: "m" });
        if (c.direction === "input") generation.setInput(value(c.value));
        else generation.setOutput(value(c.value));
        generation.end();
      });
      const key = `gen_ai.${c.direction}.messages`;
      expect(JSON.parse(span.attributes[key] as string)).toEqual(c.messages);
      expect(JSON.parse(span.attributes["rius.context.sizes"] as string)).toEqual(c.context_sizes);
    });
  }
});

function mask(spec: Case["mask"]): Mask | undefined {
  if (spec === null) return undefined;
  if ("returns" in spec) {
    const returned = value(spec.returns);
    return () => returned;
  }
  if ("format" in spec) {
    return (raw, context) =>
      (spec.format as string).replace("{key}", context?.key ?? "").replace("{value}", String(raw));
  }
  if (spec.throws) {
    return () => {
      throw new Error("mask failed");
    };
  }
  throw new Error(`unknown mask ${JSON.stringify(spec)}`);
}

describe("masking.json: the masking exporter", () => {
  for (const c of cases("masking")) {
    it(c.name, () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const inner = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({
        spanProcessors: [
          new SimpleSpanProcessor(
            new MaskingSpanExporter(inner, {
              captureContent: c.capture_content,
              mask: mask(c.mask),
            }),
          ),
        ],
      });
      const span = provider.getTracer("cases").startSpan("s", { attributes: c.span.attributes });
      for (const event of c.span.events ?? []) span.addEvent(event.name, event.attributes);
      if ("status" in c.span) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: c.span.status });
      }
      span.end();
      const [exported] = inner.getFinishedSpans();
      expect({ ...exported.attributes }).toEqual(c.expected.attributes);
      expect(
        exported.events.map((event) => ({ name: event.name, attributes: { ...event.attributes } })),
      ).toEqual(c.expected.events);
      expect(exported.status.message || null).toBe(c.expected.status);
      if ("status" in c.span) expect(exported.status.code).toBe(SpanStatusCode.ERROR);
    });
  }
});

/** Each Python field an env case names, read from the resolved TypeScript config. */
const ENV_FIELDS: Record<string, (config: ResolvedConfig) => unknown> = {
  endpoint: (config) => config.endpoint,
  service_name: (config) => config.serviceName,
  agent_name: (config) => config.agentName,
  service_version: (config) => config.serviceVersion ?? null,
  disabled: (config) => config.disabled,
  capture_content: (config) => config.captureContent,
  heartbeat: (config) => config.heartbeat,
  partial_spans: (config) => config.partialSpans,
  bridge_foreign_provider: (config) => config.bridgeForeignProvider,
  sample_rate: (config) => config.sampleRate,
  heartbeat_interval: (config) => config.heartbeatIntervalMs / 1000,
  partial_spans_delay: (config) => config.partialSpansDelayMs / 1000,
};

describe("env.json: RIUS_* variables", () => {
  for (const c of cases("env")) {
    it(c.name, () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const config = resolveConfig({}, { ...c.env });
      const resolved = Object.fromEntries(
        Object.keys(c.expected).map((field) => {
          const read = ENV_FIELDS[field];
          if (read === undefined) throw new Error(`unknown env field ${field}`);
          return [field, read(config)];
        }),
      );
      expect(resolved).toEqual(c.expected);
      if ("warns" in c) expect(warn.mock.calls.length > 0).toBe(c.warns);
    });
  }
});

describe("resource.json: OTEL_RESOURCE_ATTRIBUTES and the SDK's own keys", () => {
  for (const c of cases("resource")) {
    it(c.name, async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      clearRiusEnv();
      if (c.otel_resource_attributes !== null) {
        vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", c.otel_resource_attributes);
      }
      const options: InitOptions = {};
      if (c.options.service_name !== undefined) options.serviceName = c.options.service_name;
      if (c.options.agent_name !== undefined) options.agentName = c.options.agent_name;
      const span = await onlySpanAttributes(
        new InMemorySpanExporter(),
        () => startSpan("s").end(),
        options,
      );
      const attributes = span.resource.attributes;
      const picked = Object.fromEntries(
        Object.keys(c.expected).map((key) => [key, attributes[key]]),
      );
      expect(picked).toEqual(c.expected);
      expect((c.absent as string[]).filter((key) => key in attributes)).toEqual([]);
    });
  }
});

describe("anthropic_error_type.json: error.type on the Anthropic SDK's own spans", () => {
  for (const c of cases("anthropic_error_type")) {
    it(c.name, async () => {
      const span = await onlySpanAttributes(new InMemorySpanExporter(), () => {
        // Through the global, as the Anthropic SDK gets its tracer.
        const native = trace.getTracer(c.scope).startSpan("s", { attributes: c.attributes });
        native.setStatus({ code: SpanStatusCode.ERROR });
        native.end();
      });
      expect(span.instrumentationScope.name).toBe(c.scope);
      expect(span.attributes["error.type"]).toBe(c.expected);
    });
  }
});
