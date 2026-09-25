import type { AttributeValue, Attributes } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { type RiusClient, getTracer, init } from "../src/client.js";
import { NormalizingSpanProcessor } from "../src/normalize.js";
import { LLM_INVOCATION_PARAMETERS, RIUS_REQUEST_TOOL_CHOICE } from "../src/semconv.js";
import fixture from "./fixtures/tool_choice_cases.json" with { type: "json" };

/**
 * `tool_choice` promoted out of the OpenInference request bag.
 *
 * Context attribution prices the Anthropic tool-use preamble from whether a
 * request forced a tool call, and reads that from `rius.request.tool_choice`.
 * The request bag is content, so a `tool_choice` left inside it goes wherever
 * masking sends the bag. Normalization runs before masking and moves it out.
 *
 * The cases are `tests/fixtures/tool_choice_cases.json`, carried byte for byte
 * from the Python SDK, whose expected values are the sink's.
 */

interface Case {
  name: string;
  input: Record<string, string>;
  expected: Record<string, unknown>;
}

const cases = fixture.cases as Case[];

/** The shipped table over one bag at onEnd; the mutated bag comes back. */
function normalized(input: Record<string, string>): Record<string, AttributeValue | undefined> {
  const attributes: Attributes = { ...input };
  new NormalizingSpanProcessor().onEnd({
    attributes,
    events: [],
    status: { code: SpanStatusCode.UNSET },
    startTime: [0, 0],
  } as unknown as ReadableSpan);
  return attributes;
}

/** Keys with a value, sorted: a deleted key is gone, not undefined. */
function presentKeys(attributes: Record<string, unknown>): string[] {
  return Object.keys(attributes)
    .filter((key) => attributes[key] !== undefined)
    .sort();
}

describe("the key", () => {
  it("is the vendor one", () => {
    expect(RIUS_REQUEST_TOOL_CHOICE).toBe("rius.request.tool_choice");
  });
});

describe("the shared cases", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const out = normalized(c.input);
    expect(presentKeys(out)).toEqual(presentKeys(c.expected));
    for (const [key, want] of Object.entries(c.expected)) {
      if (key === LLM_INVOCATION_PARAMETERS) {
        // Parsed: how the leftover bag is spelled is the serializer's business.
        expect(JSON.parse(out[key] as string)).toEqual(want);
      } else {
        expect(out[key]).toEqual(want);
      }
    }
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    "%s: never gen_ai.request.tool_choice",
    (_n, c) => {
      // The GenAI conventions define no tool_choice.
      expect(normalized(c.input)["gen_ai.request.tool_choice"]).toBeUndefined();
    },
  );

  it.each(cases.map((c) => [c.name, c] as const))("%s: idempotent", (_n, c) => {
    // The processor maps at start and again at end.
    const once = normalized(c.input);
    const defined = Object.fromEntries(
      Object.entries(once).filter(([, value]) => value !== undefined),
    ) as Record<string, string>;
    expect(normalized(defined)).toEqual(defined);
  });
});

describe("on a bare provider", () => {
  it("puts the key on the live span at start and takes the member out of the bag", async () => {
    const collected = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new NormalizingSpanProcessor(), new SimpleSpanProcessor(collected)],
    });
    const span = provider.getTracer("t").startSpan("ChatCompletion", {
      attributes: {
        [LLM_INVOCATION_PARAMETERS]: JSON.stringify({
          tool_choice: { type: "tool", name: "get_weather" },
          user: "u",
        }),
      },
    });
    const live = { ...(span as unknown as ReadableSpan).attributes };
    span.end();
    const [exported] = collected.getFinishedSpans();
    await provider.shutdown();

    expect(live[RIUS_REQUEST_TOOL_CHOICE]).toBe('{"type":"tool","name":"get_weather"}');
    expect(exported.attributes[RIUS_REQUEST_TOOL_CHOICE]).toBe(
      '{"type":"tool","name":"get_weather"}',
    );
    expect(JSON.parse(exported.attributes[LLM_INVOCATION_PARAMETERS] as string)).toEqual({
      user: "u",
    });
  });
});

describe("through init()", () => {
  let client: RiusClient | undefined;
  afterEach(async () => {
    await client?.shutdown();
    client = undefined;
  });

  it.each([true, false])("survives captureContent: %s", async (captureContent) => {
    const exporter = new InMemorySpanExporter();
    client = init({ captureContent, spanExporter: exporter, heartbeatTransport: async () => {} });
    getTracer()
      .startSpan("ChatCompletion", {
        attributes: {
          "openinference.span.kind": "LLM",
          [LLM_INVOCATION_PARAMETERS]: JSON.stringify({
            tool_choice: { type: "tool", name: "sentinel_tool_7f3a" },
            tools: [{ name: "lookup", description: "SECRET-PROMPT" }],
          }),
        },
      })
      .end();
    await client.flush();
    const [span] = exporter.getFinishedSpans();

    expect(span.attributes[RIUS_REQUEST_TOOL_CHOICE]).toBe(
      '{"type":"tool","name":"sentinel_tool_7f3a"}',
    );
    expect(span.attributes["gen_ai.request.tool_choice"]).toBeUndefined();
    const bag = span.attributes[LLM_INVOCATION_PARAMETERS];
    if (captureContent) {
      expect(JSON.parse(bag as string)).toEqual({
        tools: [{ name: "lookup", description: "SECRET-PROMPT" }],
      });
    } else {
      // Whether masking drops the whole bag or only its content members, the
      // member is not in whatever is left, and no content survives.
      expect(bag === undefined || !("tool_choice" in JSON.parse(bag as string))).toBe(true);
      expect(JSON.stringify(span.attributes)).not.toContain("SECRET");
    }
  });
});
