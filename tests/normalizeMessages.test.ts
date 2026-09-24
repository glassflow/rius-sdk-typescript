import { type AttributeValue, type Attributes, SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { type RiusClient, getTracer, init } from "../src/client.js";
import { NormalizingSpanProcessor, reassembleOpenInferenceMessages } from "../src/normalize.js";
import { GEN_AI_INPUT_MESSAGES, GEN_AI_OUTPUT_MESSAGES } from "../src/semconv.js";
import { MAX_ATTR_CHARS, TRUNCATION_MARKER } from "../src/serde.js";
import fixture from "./fixtures/openinference_messages.json" with { type: "json" };

/**
 * OpenInference's flattened messages reassembled into gen_ai.input/output.messages,
 * ported from the Python SDK.
 *
 * `tests/fixtures/openinference_messages.json` is the Python SDK's file,
 * copied byte for byte (biome is told not to reformat it), so both SDKs are
 * held to the same exact strings. Every case marked `sink_identical` also
 * matches the sink's `reassembleMessages`; the others are multimodal, which
 * the sink does not reassemble yet.
 */

interface Case {
  name: string;
  sink_identical: boolean;
  attributes: Record<string, AttributeValue>;
  expected: Record<string, AttributeValue>;
}

const cases = (fixture as unknown as { cases: Case[] }).cases;

/** An ended span over a bag, with nothing else for the event passes to read. */
function endedSpan(attributes: Attributes): ReadableSpan {
  return {
    attributes,
    events: [],
    status: { code: SpanStatusCode.UNSET },
    startTime: [0, 0],
  } as unknown as ReadableSpan;
}

describe("the shared fixture", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, testCase) => {
    const attributes = { ...testCase.attributes };
    reassembleOpenInferenceMessages(attributes);
    expect(attributes).toEqual(testCase.expected);
    // Byte for byte: the raw strings, not their parse.
    for (const key of [GEN_AI_INPUT_MESSAGES, GEN_AI_OUTPUT_MESSAGES]) {
      if (key in testCase.expected) expect(attributes[key]).toBe(testCase.expected[key]);
    }
  });

  it("covers the cases the ticket names", () => {
    const names = cases.map((c) => c.name).join(" ");
    for (const needle of ["user", "system", "tool call", "response", "multimodal"]) {
      expect(names).toContain(needle);
    }
  });
});

describe("reassembleOpenInferenceMessages", () => {
  it("reports whether it changed anything", () => {
    expect(reassembleOpenInferenceMessages({})).toBe(false);
    expect(reassembleOpenInferenceMessages({ "gen_ai.request.model": "gpt-4o" })).toBe(false);
    expect(reassembleOpenInferenceMessages({ "llm.input_messages.0.message.role": "user" })).toBe(
      true,
    );
  });

  it("leaves a span whose families are both native alone", () => {
    const attributes = {
      [GEN_AI_INPUT_MESSAGES]: "[]",
      [GEN_AI_OUTPUT_MESSAGES]: "[]",
      "llm.input_messages.0.message.role": "user",
      "llm.output_messages.0.message.role": "assistant",
    };
    const before = { ...attributes };
    expect(reassembleOpenInferenceMessages(attributes)).toBe(false);
    expect(attributes).toEqual(before);
  });

  it("leaves a family holding a non-string value untouched, and still does the other", () => {
    const attributes: Record<string, AttributeValue> = {
      "llm.input_messages.0.message.role": "user",
      "llm.input_messages.0.message.content": 42,
      "llm.output_messages.0.message.role": "assistant",
      "llm.output_messages.0.message.content": "yo",
    };
    reassembleOpenInferenceMessages(attributes);
    expect(attributes).toEqual({
      "llm.input_messages.0.message.role": "user",
      "llm.input_messages.0.message.content": 42,
      [GEN_AI_OUTPUT_MESSAGES]: '[{"role":"assistant","parts":[{"type":"text","content":"yo"}]}]',
    });
  });

  it("leaves a family whose contents hold a non-string value untouched", () => {
    const attributes: Record<string, AttributeValue> = {
      "llm.input_messages.0.message.role": "user",
      "llm.input_messages.0.message.contents.0.message_content.type": "text",
      "llm.input_messages.0.message.contents.0.message_content.text": ["a"],
    };
    const before = { ...attributes };
    expect(reassembleOpenInferenceMessages(attributes)).toBe(false);
    expect(attributes).toEqual(before);
  });

  it("applies the attribute cap like native messages", () => {
    const attributes: Record<string, AttributeValue> = {
      "llm.input_messages.0.message.role": "user",
      "llm.input_messages.0.message.content": "x".repeat(MAX_ATTR_CHARS * 2),
    };
    reassembleOpenInferenceMessages(attributes);
    const value = attributes[GEN_AI_INPUT_MESSAGES] as string;
    expect(value.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(value.length).toBe(MAX_ATTR_CHARS + TRUNCATION_MARKER.length);
    expect(value.startsWith('[{"role":"user","parts":[{"type":"text","content":"xxx')).toBe(true);
    expect(Object.keys(attributes)).toEqual([GEN_AI_INPUT_MESSAGES]);
  });

  it("does not match keys through the prototype chain", () => {
    // A native-wins check by bare lookup would see Object.prototype members.
    const attributes: Record<string, AttributeValue> = Object.create({
      [GEN_AI_INPUT_MESSAGES]: "inherited",
    });
    attributes["llm.input_messages.0.message.role"] = "user";
    reassembleOpenInferenceMessages(attributes);
    expect(Object.hasOwn(attributes, GEN_AI_INPUT_MESSAGES)).toBe(true);
    expect(attributes[GEN_AI_INPUT_MESSAGES]).toBe('[{"role":"user","parts":[]}]');
  });
});

describe("in the processor", () => {
  it("reassembles at onEnd, deletes the flattened keys, and runs beside the table", () => {
    const attributes: Attributes = {
      "openinference.span.kind": "LLM",
      "llm.provider": "openai",
      "llm.input_messages.0.message.role": "user",
      "llm.input_messages.0.message.content": "hi",
      "llm.output_messages.0.message.role": "assistant",
      "llm.output_messages.0.message.content": "yo",
    };
    new NormalizingSpanProcessor().onEnd(endedSpan(attributes));
    expect(attributes[GEN_AI_INPUT_MESSAGES]).toBe(
      '[{"role":"user","parts":[{"type":"text","content":"hi"}]}]',
    );
    expect(attributes[GEN_AI_OUTPUT_MESSAGES]).toBe(
      '[{"role":"assistant","parts":[{"type":"text","content":"yo"}]}]',
    );
    expect(Object.keys(attributes).filter((k) => k.startsWith("llm."))).toEqual([]);
    expect(attributes["gen_ai.provider.name"]).toBe("openai");
  });

  it("does not reassemble at onStart: messages are content and never ride a snapshot", () => {
    const bag: Record<string, AttributeValue> = {
      "openinference.span.kind": "LLM",
      "llm.input_messages.0.message.role": "user",
      "llm.input_messages.0.message.content": "hi",
    };
    const span = {
      attributes: bag,
      setAttribute(key: string, value: AttributeValue) {
        bag[key] = value;
        return this;
      },
    };
    new NormalizingSpanProcessor().onStart(span as never, undefined as never);
    expect(bag[GEN_AI_INPUT_MESSAGES]).toBeUndefined();
    expect(bag["llm.input_messages.0.message.content"]).toBe("hi");
  });
});

describe("through init()", () => {
  let client: RiusClient | undefined;
  afterEach(async () => {
    await client?.shutdown();
    client = undefined;
  });

  async function exported(captureContent: boolean): Promise<Attributes> {
    const exporter = new InMemorySpanExporter();
    client = init({ spanExporter: exporter, heartbeatTransport: async () => {}, captureContent });
    getTracer()
      .startSpan("ChatCompletion", {
        attributes: {
          "openinference.span.kind": "LLM",
          "llm.input_messages.0.message.role": "user",
          "llm.input_messages.0.message.content": "SECRET-PROMPT",
          // A field reassembly does not read, so it stays flattened.
          "llm.input_messages.0.message.name": "SECRET-NAME",
          "llm.output_messages.0.message.role": "assistant",
          "llm.output_messages.0.message.content": "SECRET-ANSWER",
        },
      })
      .end();
    await client.flush();
    return exporter.getFinishedSpans()[0].attributes;
  }

  it("exports the reassembled messages with content capture on", async () => {
    const attributes = await exported(true);
    expect(JSON.parse(attributes[GEN_AI_INPUT_MESSAGES] as string)).toEqual([
      { role: "user", parts: [{ type: "text", content: "SECRET-PROMPT" }] },
    ]);
    expect(Object.keys(attributes).filter((k) => k.startsWith("llm."))).toEqual([
      "llm.input_messages.0.message.name",
    ]);
  });

  it("strips both the flattened sources and the canonical targets with capture off", async () => {
    const attributes = await exported(false);
    expect(attributes[GEN_AI_INPUT_MESSAGES]).toBeUndefined();
    expect(attributes[GEN_AI_OUTPUT_MESSAGES]).toBeUndefined();
    expect(Object.keys(attributes).filter((k) => k.startsWith("llm."))).toEqual([]);
    expect(JSON.stringify(attributes)).not.toContain("SECRET");
  });
});
