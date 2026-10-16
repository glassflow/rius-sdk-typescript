import type { Attributes, AttributeValue } from "@opentelemetry/api";
import type { ReadableSpan, Span, TimedEvent } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { NormalizingSpanProcessor, VERCEL_FIRST_CHUNK_EVENT } from "../src/normalize.js";
import fixture from "./fixtures/vercel_cases.json" with { type: "json" };

/**
 * The Vercel AI SDK's own telemetry (v5/v6, the ai.* dialect) mapped straight
 * onto the conventions.
 *
 * The cases are tests/fixtures/vercel_cases.json. The sink carries the same
 * file and must store the same attributes from the same span, so a change
 * here is a change there.
 */

interface Case {
  name: string;
  input: Record<string, AttributeValue>;
  expected: Record<string, AttributeValue>;
}

const cases = fixture.cases as unknown as Case[];

function ended(attributes: Attributes, events: TimedEvent[] = []): ReadableSpan {
  return {
    attributes,
    events,
    status: { code: 0 },
    startTime: [1700000000, 0],
    endTime: [1700000001, 0],
  } as unknown as ReadableSpan;
}

function starting(attributes: Attributes): Span {
  const bag = attributes as Record<string, AttributeValue>;
  return {
    attributes: bag,
    setAttribute(key: string, value: AttributeValue) {
      bag[key] = value;
      return this;
    },
  } as unknown as Span;
}

/** The shipped processor over one bag at onEnd; the keys with a value come back. */
function normalized(input: Record<string, AttributeValue>): Record<string, AttributeValue> {
  const attributes: Attributes = structuredClone(input);
  new NormalizingSpanProcessor().onEnd(ended(attributes));
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined),
  ) as Record<string, AttributeValue>;
}

describe("the shared cases", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(normalized(c.input)).toEqual(c.expected);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s: a second pass changes nothing", (_n, c) => {
    expect(normalized(c.expected)).toEqual(c.expected);
  });
});

describe("at span start", () => {
  it("maps what a pending snapshot shows, and nothing it must not carry", () => {
    const attributes: Attributes = {
      "ai.operationId": "ai.streamText.doStream",
      "ai.model.provider": "openai.chat",
      "ai.model.id": "gpt-4o-mini",
      "ai.settings.temperature": 0.2,
      "ai.prompt.messages": '[{"role":"user","content":"hi"}]',
    };
    new NormalizingSpanProcessor().onStart(starting(attributes), {} as never);
    expect(attributes).toEqual({
      "ai.operationId": "ai.streamText.doStream",
      "openinference.span.kind": "LLM",
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.request.temperature": 0.2,
      // Content waits for the end, where it is mapped before masking.
      "ai.prompt.messages": '[{"role":"user","content":"hi"}]',
    });
  });

  it("classifies a still-running rerank", () => {
    const attributes: Attributes = {
      "ai.operationId": "ai.rerank.doRerank",
      "ai.model.provider": "cohere.reranking",
      "ai.model.id": "rerank-v3.5",
      "ai.documents": ['"a"', '"b"'],
    };
    new NormalizingSpanProcessor().onStart(starting(attributes), {} as never);
    expect(attributes).toEqual({
      "ai.operationId": "ai.rerank.doRerank",
      "gen_ai.operation.name": "rerank",
      "openinference.span.kind": "RERANKER",
      "gen_ai.provider.name": "cohere",
      "gen_ai.request.model": "rerank-v3.5",
      "ai.documents": ['"a"', '"b"'],
    });
  });

  it("names a still-running tool call", () => {
    const attributes: Attributes = {
      "ai.operationId": "ai.toolCall",
      "ai.toolCall.name": "get_weather",
      "ai.toolCall.id": "call_1",
      "ai.toolCall.args": '{"city":"Paris"}',
    };
    new NormalizingSpanProcessor().onStart(starting(attributes), {} as never);
    expect(attributes).toEqual({
      "ai.operationId": "ai.toolCall",
      "openinference.span.kind": "TOOL",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.type": "function",
      "gen_ai.tool.name": "get_weather",
      "gen_ai.tool.call.id": "call_1",
      "ai.toolCall.args": '{"city":"Paris"}',
    });
  });
});

describe("the first-chunk event", () => {
  const firstChunk = (): TimedEvent => ({
    name: VERCEL_FIRST_CHUNK_EVENT,
    time: [1700000000, 250_000_000],
    attributes: { "ai.response.msToFirstChunk": 250 },
  });

  it("stays as recorded, and no gen_ai.first_token event is added", () => {
    const events = [firstChunk()];
    const attributes: Attributes = {
      "ai.operationId": "ai.streamText.doStream",
      "ai.response.msToFirstChunk": 250,
    };
    new NormalizingSpanProcessor().onEnd(ended(attributes, events));
    expect(events.map((e) => e.name)).toEqual([VERCEL_FIRST_CHUNK_EVENT]);
    expect(events[0]?.time).toEqual([1700000000, 250_000_000]);
    expect(attributes["gen_ai.response.time_to_first_chunk"]).toBe(0.25);
    expect(attributes["gen_ai.request.stream"]).toBe(true);
  });

  it("gives a span the table does not map the duration from the event's time", () => {
    const events = [firstChunk()];
    const attributes: Attributes = {};
    new NormalizingSpanProcessor().onEnd(ended(attributes, events));
    expect(events.map((e) => e.name)).toEqual([VERCEL_FIRST_CHUNK_EVENT]);
    expect(attributes["gen_ai.response.time_to_first_chunk"]).toBe(0.25);
    expect(attributes["gen_ai.request.stream"]).toBe(true);
  });
});
