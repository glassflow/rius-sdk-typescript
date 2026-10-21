import type { Attributes, AttributeValue } from "@opentelemetry/api";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { init, type RiusClient } from "../src/client.js";
import { MaskingSpanExporter } from "../src/masking.js";
import { NormalizingSpanProcessor } from "../src/normalize.js";
import {
  GEN_AI_CONVERSATION_COMPACTED,
  OUTPUT_VALUE,
  RIUS_COMPACTION_EVENT,
  RIUS_COMPACTION_EXECUTOR,
  RIUS_COMPACTION_ID,
  RIUS_COMPACTION_KIND,
  RIUS_COMPACTION_SUMMARY_BYTES,
  RIUS_COMPACTION_SUMMARY_TEXT,
  RIUS_COMPACTION_TOKENS_AFTER,
  RIUS_COMPACTION_TOKENS_BEFORE,
  RIUS_COMPACTION_TOKENS_DROPPED,
  RIUS_COMPACTION_TOOL_RESULTS_CLEARED,
  RIUS_COMPACTION_TRIGGER,
} from "../src/semconv.js";

interface FakeEvent {
  name: string;
  time: [number, number];
  attributes?: Attributes;
}

const END_TIME: [number, number] = [1700, 42];

const LLM: Attributes = { "openinference.span.kind": "LLM" };

/** The shipped processor over one fake span at onEnd; the mutated span comes back. */
function ended(
  attributes: Attributes,
  events: FakeEvent[] = [],
): { attributes: Record<string, AttributeValue | undefined>; events: FakeEvent[] } {
  const span = {
    attributes: { ...attributes },
    events,
    links: [],
    status: { code: SpanStatusCode.UNSET },
    startTime: [1600, 0],
    endTime: END_TIME,
  };
  new NormalizingSpanProcessor().onEnd(span as unknown as ReadableSpan);
  return span;
}

function respond(body: unknown, extra: Attributes = {}): Attributes {
  return {
    ...LLM,
    [OUTPUT_VALUE]: typeof body === "string" ? body : JSON.stringify(body),
    ...extra,
  };
}

function compactionEvents(span: { events: FakeEvent[] }): FakeEvent[] {
  return span.events.filter((event) => event.name === RIUS_COMPACTION_EVENT);
}

const toolEdit = {
  type: "clear_tool_uses_20250919",
  cleared_tool_uses: 3,
  cleared_input_tokens: 12000,
};
const thinkingEdit = {
  type: "clear_thinking_20251015",
  cleared_thinking_turns: 2,
  cleared_input_tokens: 800,
};

describe("Anthropic context editing", () => {
  it("records a tool-use edit as a provider clear_tool_results event", () => {
    const span = ended(respond({ id: "msg_1", context_management: { applied_edits: [toolEdit] } }));
    const events = compactionEvents(span);
    expect(events).toHaveLength(1);
    expect(events[0].attributes).toEqual({
      [RIUS_COMPACTION_KIND]: "clear_tool_results",
      [RIUS_COMPACTION_EXECUTOR]: "provider",
      [RIUS_COMPACTION_TRIGGER]: "auto",
      [RIUS_COMPACTION_TOKENS_DROPPED]: 12000,
      [RIUS_COMPACTION_TOOL_RESULTS_CLEARED]: 3,
    });
    expect(events[0].time).toEqual(END_TIME);
    expect(span.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
  });

  it("records a thinking edit as clear_thinking, with no tool-result count", () => {
    const span = ended(respond({ context_management: { applied_edits: [thinkingEdit] } }));
    expect(compactionEvents(span)[0].attributes).toEqual({
      [RIUS_COMPACTION_KIND]: "clear_thinking",
      [RIUS_COMPACTION_EXECUTOR]: "provider",
      [RIUS_COMPACTION_TRIGGER]: "auto",
      [RIUS_COMPACTION_TOKENS_DROPPED]: 800,
    });
  });

  it("records one event per edit, in order", () => {
    const span = ended(
      respond({ context_management: { applied_edits: [thinkingEdit, toolEdit] } }),
    );
    expect(compactionEvents(span).map((e) => e.attributes?.[RIUS_COMPACTION_KIND])).toEqual([
      "clear_thinking",
      "clear_tool_results",
    ]);
  });

  it("skips a count that is not a non-negative integer, and keeps the event", () => {
    for (const bad of ["-1", "1.5", '"12"', "null", "true", "1e400"]) {
      const span = ended(
        respond(
          `{"context_management":{"applied_edits":[{"type":"clear_tool_uses_20250919","cleared_tool_uses":${bad},"cleared_input_tokens":${bad}}]}}`,
        ),
      );
      const [event] = compactionEvents(span);
      expect(event.attributes, String(bad)).toEqual({
        [RIUS_COMPACTION_KIND]: "clear_tool_results",
        [RIUS_COMPACTION_EXECUTOR]: "provider",
        [RIUS_COMPACTION_TRIGGER]: "auto",
      });
    }
  });

  it("keeps a zero count", () => {
    const span = ended(
      respond({
        context_management: {
          applied_edits: [{ type: "clear_tool_uses_20250919", cleared_tool_uses: 0 }],
        },
      }),
    );
    expect(compactionEvents(span)[0].attributes?.[RIUS_COMPACTION_TOOL_RESULTS_CLEARED]).toBe(0);
  });

  it("ignores an edit it cannot classify", () => {
    for (const edit of [
      { type: "something_new_2030" },
      { cleared_tool_uses: 2 },
      { type: 7 },
      { type: "constructor" },
      { type: "__proto__" },
      null,
      "clear_tool_uses",
      [],
    ]) {
      const span = ended(respond({ context_management: { applied_edits: [edit] } }));
      expect(compactionEvents(span), JSON.stringify(edit)).toEqual([]);
      expect(span.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
    }
  });
});

describe("edit fields that belong to the other kind", () => {
  it("does not read a cleared tool-use count off a thinking edit", () => {
    const span = ended(
      respond({
        context_management: {
          applied_edits: [{ ...thinkingEdit, cleared_tool_uses: 9 }],
        },
      }),
    );
    const [event] = compactionEvents(span);
    expect(event.attributes?.[RIUS_COMPACTION_KIND]).toBe("clear_thinking");
    expect(event.attributes).not.toHaveProperty(RIUS_COMPACTION_TOOL_RESULTS_CLEARED);
  });
});

describe("Anthropic compaction block", () => {
  const summary = "The user asked for a refactor; the plan is agreed.";
  const block = { type: "compaction", content: summary };

  it("records a provider summarize event with the summary and its size", () => {
    const span = ended(
      respond({
        content: [block, { type: "text", text: "Continuing." }],
        usage: {
          iterations: [
            { type: "compaction", input_tokens: 180000, output_tokens: 3500 },
            { type: "message", input_tokens: 23000, output_tokens: 1000 },
          ],
        },
      }),
    );
    const events = compactionEvents(span);
    expect(events).toHaveLength(1);
    expect(events[0].attributes).toEqual({
      [RIUS_COMPACTION_KIND]: "summarize",
      [RIUS_COMPACTION_EXECUTOR]: "provider",
      [RIUS_COMPACTION_TRIGGER]: "auto",
      [RIUS_COMPACTION_TOKENS_BEFORE]: 180000,
      [RIUS_COMPACTION_TOKENS_AFTER]: 23000,
      [RIUS_COMPACTION_SUMMARY_BYTES]: Buffer.byteLength(summary, "utf8"),
      [RIUS_COMPACTION_SUMMARY_TEXT]: summary,
    });
    expect(events[0].time).toEqual(END_TIME);
    expect(span.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
  });

  it("gives the request's token sizes to the first compaction block only", () => {
    const span = ended(
      respond({
        content: [block, { type: "compaction", content: "second" }],
        usage: {
          iterations: [
            { type: "compaction", input_tokens: 180000 },
            { type: "message", input_tokens: 23000 },
          ],
        },
      }),
    );
    const [first, second] = compactionEvents(span);
    expect(first.attributes?.[RIUS_COMPACTION_TOKENS_BEFORE]).toBe(180000);
    expect(second.attributes).not.toHaveProperty(RIUS_COMPACTION_TOKENS_BEFORE);
    expect(second.attributes).not.toHaveProperty(RIUS_COMPACTION_TOKENS_AFTER);
  });

  it("measures the summary in UTF-8 bytes, not characters", () => {
    const text = "héllo ✓ 日本";
    const span = ended(respond({ content: [{ type: "compaction", content: text }] }));
    const bytes = compactionEvents(span)[0].attributes?.[RIUS_COMPACTION_SUMMARY_BYTES];
    expect(bytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(bytes).not.toBe(text.length);
  });

  it("without iterations has no token sizes", () => {
    const span = ended(respond({ content: [block] }));
    const attributes = compactionEvents(span)[0].attributes ?? {};
    expect(attributes[RIUS_COMPACTION_KIND]).toBe("summarize");
    expect(Object.hasOwn(attributes, RIUS_COMPACTION_TOKENS_BEFORE)).toBe(false);
    expect(Object.hasOwn(attributes, RIUS_COMPACTION_TOKENS_AFTER)).toBe(false);
  });

  it("with only the compaction iteration has a before size and no after", () => {
    const span = ended(
      respond({
        content: [block],
        usage: { iterations: [{ type: "compaction", input_tokens: 9000 }] },
      }),
    );
    const attributes = compactionEvents(span)[0].attributes ?? {};
    expect(attributes[RIUS_COMPACTION_TOKENS_BEFORE]).toBe(9000);
    expect(Object.hasOwn(attributes, RIUS_COMPACTION_TOKENS_AFTER)).toBe(false);
  });

  it("takes the before size from the compaction iteration wherever it sits", () => {
    const span = ended(
      respond({
        content: [block],
        usage: {
          iterations: [
            { type: "message", input_tokens: 1 },
            { type: "compaction", input_tokens: 500 },
            { type: "message", input_tokens: 70 },
          ],
        },
      }),
    );
    const attributes = compactionEvents(span)[0].attributes ?? {};
    expect(attributes[RIUS_COMPACTION_TOKENS_BEFORE]).toBe(500);
    expect(attributes[RIUS_COMPACTION_TOKENS_AFTER]).toBe(70);
  });

  it("does not call the compaction iteration the after size when it is last", () => {
    const span = ended(
      respond({
        content: [block],
        usage: {
          iterations: [
            { type: "message", input_tokens: 1 },
            { type: "compaction", input_tokens: 500 },
          ],
        },
      }),
    );
    const attributes = compactionEvents(span)[0].attributes ?? {};
    expect(attributes[RIUS_COMPACTION_TOKENS_BEFORE]).toBe(500);
    expect(Object.hasOwn(attributes, RIUS_COMPACTION_TOKENS_AFTER)).toBe(false);
  });

  it("skips odd iteration sizes", () => {
    for (const bad of [-5, 2.5, "9", null]) {
      const span = ended(
        respond({
          content: [block],
          usage: {
            iterations: [
              { type: "compaction", input_tokens: bad },
              { type: "message", input_tokens: bad },
            ],
          },
        }),
      );
      const attributes = compactionEvents(span)[0].attributes ?? {};
      expect(Object.hasOwn(attributes, RIUS_COMPACTION_TOKENS_BEFORE), String(bad)).toBe(false);
      expect(Object.hasOwn(attributes, RIUS_COMPACTION_TOKENS_AFTER), String(bad)).toBe(false);
    }
  });

  it("omits the summary when the block carries no text", () => {
    for (const content of [undefined, "", 12, null, ["x"], { text: "y" }]) {
      const span = ended(respond({ content: [{ type: "compaction", content }] }));
      const attributes = compactionEvents(span)[0].attributes ?? {};
      expect(attributes[RIUS_COMPACTION_KIND], JSON.stringify(content)).toBe("summarize");
      expect(Object.hasOwn(attributes, RIUS_COMPACTION_SUMMARY_BYTES)).toBe(false);
      expect(Object.hasOwn(attributes, RIUS_COMPACTION_SUMMARY_TEXT)).toBe(false);
    }
  });

  it("is recorded beside context-editing events", () => {
    const span = ended(
      respond({ content: [block], context_management: { applied_edits: [toolEdit] } }),
    );
    expect(compactionEvents(span).map((e) => e.attributes?.[RIUS_COMPACTION_KIND])).toEqual([
      "clear_tool_results",
      "summarize",
    ]);
  });
});

describe("OpenAI compaction item", () => {
  const item = { type: "compaction", id: "cmp_123", encrypted_content: "ENCRYPTED-BLOB-XYZ" };

  it("records a provider summarize event with the item's id and never the blob", () => {
    const span = ended(
      respond({
        id: "resp_1",
        object: "response",
        output: [{ type: "message", content: [] }, item],
      }),
    );
    const events = compactionEvents(span);
    expect(events).toHaveLength(1);
    expect(events[0].attributes).toEqual({
      [RIUS_COMPACTION_KIND]: "summarize",
      [RIUS_COMPACTION_EXECUTOR]: "provider",
      [RIUS_COMPACTION_TRIGGER]: "auto",
      [RIUS_COMPACTION_ID]: "cmp_123",
    });
    expect(JSON.stringify(span.events)).not.toContain("ENCRYPTED-BLOB-XYZ");
    expect(span.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
  });

  it("omits the id unless it is a non-empty string", () => {
    for (const id of [undefined, "", 7, null, {}]) {
      const span = ended(respond({ output: [{ type: "compaction", id }] }));
      const attributes = compactionEvents(span)[0].attributes ?? {};
      expect(Object.hasOwn(attributes, RIUS_COMPACTION_ID), JSON.stringify(id)).toBe(false);
    }
  });

  it("ignores output items whose type only resembles it", () => {
    const span = ended(
      respond({
        object: "response",
        output: [{ type: "compaction_summary", encrypted_content: "x" }, { type: "Compaction" }],
      }),
    );
    expect(compactionEvents(span)).toEqual([]);
    expect(span.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
  });
});

describe("payloads that are not a provider compaction", () => {
  const edits = { context_management: { applied_edits: [toolEdit] } };

  function expectNothing(attributes: Attributes): void {
    const span = ended(attributes);
    expect(compactionEvents(span)).toEqual([]);
    expect(span.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
  }

  it("reads only own members, so an inherited one is not a payload", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.content = [{ type: "compaction", content: "inherited" }];
    proto.output = [{ type: "compaction", id: "inherited" }];
    proto.context_management = { applied_edits: [toolEdit] };
    try {
      expectNothing(respond('{"compaction":true}'));
    } finally {
      delete proto.content;
      delete proto.output;
      delete proto.context_management;
    }
  });

  it("ignores output that is not JSON, without throwing", () => {
    for (const text of ['{"context_management": {"applied_edits": [', "{compaction", "{", "{}"]) {
      expectNothing(respond(text));
    }
  });

  it("ignores output that is not a string, or does not start with an object", () => {
    expectNothing({ ...LLM, [OUTPUT_VALUE]: 12 });
    expectNothing({ ...LLM, [OUTPUT_VALUE]: [JSON.stringify(edits)] });
    expectNothing(respond(` ${JSON.stringify(edits)}`));
    expectNothing(respond([edits]));
    expectNothing(respond("null"));
    expectNothing(respond(`[{"type":"compaction"}]`));
  });

  it("ignores output declared plain text, the model's own words", () => {
    expectNothing(respond(edits, { "output.mime_type": "text/plain" }));
    expectNothing(
      respond(
        { content: [{ type: "compaction", content: "x" }] },
        { "output.mime_type": "text/plain" },
      ),
    );
  });

  it("takes output declared JSON, or undeclared", () => {
    const declared = ended(respond(edits, { "output.mime_type": "application/json" }));
    expect(compactionEvents(declared)).toHaveLength(1);
  });

  it("ignores a span that is not an LLM span", () => {
    for (const kind of ["TOOL", "CHAIN", "EMBEDDING", "AGENT", "RETRIEVER"]) {
      expectNothing({ "openinference.span.kind": kind, [OUTPUT_VALUE]: JSON.stringify(edits) });
    }
    expectNothing({ [OUTPUT_VALUE]: JSON.stringify(edits) });
  });

  it("reads a span the operation name makes an LLM span", () => {
    const span = ended({ "gen_ai.operation.name": "chat", [OUTPUT_VALUE]: JSON.stringify(edits) });
    expect(compactionEvents(span)).toHaveLength(1);
  });

  it("ignores prototype-chain keys, and keys the wrong shape", () => {
    for (const text of [
      '{"__proto__":{"context_management":{"applied_edits":[{"type":"clear_tool_uses_20250919"}]}}}',
      '{"constructor":{"context_management":{"applied_edits":[{"type":"clear_tool_uses_20250919"}]}}}',
      '{"context_management":null}',
      '{"context_management":[]}',
      '{"context_management":{"applied_edits":"clear_tool_uses"}}',
      '{"context_management":{"applied_edits":{"0":{"type":"clear_tool_uses_20250919"}}}}',
      '{"context_management":{"applied_edits":[]}}',
      '{"content":"compaction"}',
      '{"content":{"type":"compaction"}}',
      '{"content":[null,7,"compaction",[]]}',
      '{"content":[{"type":"text","text":"compaction"}]}',
      '{"output":{"type":"compaction"}}',
      '{"output":[{"type":"message","content":"compaction"}]}',
      '{"output":[null,7,[]]}',
      '{"usage":{"iterations":[{"type":"compaction","input_tokens":5}]}}',
    ]) {
      expectNothing(respond(text));
    }
  });

  it("reads a key that exists only as an own property", () => {
    // JSON.parse gives "__proto__" as an own key; reading the payload's
    // members must never fall through to Object.prototype either.
    const span = ended(
      respond(
        '{"__proto__":{"x":1},"context_management":{"__proto__":{"applied_edits":[{"type":"clear_tool_uses_20250919"}]}}}',
      ),
    );
    expect(compactionEvents(span)).toEqual([]);
  });
});

describe("native wins and idempotence", () => {
  const body = { context_management: { applied_edits: [toolEdit] } };

  it("adds nothing when the span already carries a compaction event", () => {
    const native: FakeEvent = {
      name: RIUS_COMPACTION_EVENT,
      time: [1650, 0],
      attributes: { [RIUS_COMPACTION_KIND]: "truncate", [RIUS_COMPACTION_EXECUTOR]: "client" },
    };
    const span = ended(respond(body), [native]);
    expect(span.events).toEqual([native]);
    expect(span.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
  });

  it("is idempotent when the processor runs twice over one span", () => {
    const span = {
      attributes: respond(body),
      events: [] as FakeEvent[],
      links: [],
      status: { code: SpanStatusCode.UNSET },
      startTime: [1600, 0],
      endTime: END_TIME,
    };
    const processor = new NormalizingSpanProcessor();
    processor.onEnd(span as unknown as ReadableSpan);
    processor.onEnd(span as unknown as ReadableSpan);
    expect(compactionEvents(span)).toHaveLength(1);
  });

  it("keeps the events a span already carries, ahead of the new ones", () => {
    const other: FakeEvent = { name: "something.else", time: [1601, 0] };
    const span = ended(respond(body), [other]);
    expect(span.events.map((e) => e.name)).toEqual(["something.else", RIUS_COMPACTION_EVENT]);
  });

  it("leaves a span with no event list alone", () => {
    const span = {
      attributes: respond(body),
      links: [],
      status: { code: SpanStatusCode.UNSET },
      startTime: [1600, 0],
      endTime: END_TIME,
    };
    expect(() =>
      new NormalizingSpanProcessor().onEnd(span as unknown as ReadableSpan),
    ).not.toThrow();
  });
});

describe("through the exporter chain", () => {
  let client: RiusClient | undefined;
  afterEach(async () => {
    await client?.shutdown();
    client = undefined;
  });

  const summary = "SECRET-SUMMARY-OF-THE-CONVERSATION";
  const response = {
    id: "msg_9",
    content: [{ type: "compaction", content: summary }],
    usage: {
      iterations: [
        { type: "compaction", input_tokens: 100 },
        { type: "message", input_tokens: 10 },
      ],
    },
  };

  async function exportOne(options: Parameters<typeof init>[0]): Promise<ReadableSpan> {
    const exporter = new InMemorySpanExporter();
    client = init({
      spanExporter: exporter,
      heartbeat: false,
      serviceName: "compaction-test",
      ...options,
    });
    trace
      .getTracer("t")
      .startSpan("Anthropic Messages", {
        attributes: { ...LLM, [OUTPUT_VALUE]: JSON.stringify(response) },
      })
      .end();
    await client.flush();
    const [span] = exporter.getFinishedSpans();
    return span;
  }

  it("captureContent false strips the summary text and keeps its size", async () => {
    const span = await exportOne({ captureContent: false });
    const event = span.events.find((e) => e.name === RIUS_COMPACTION_EVENT);
    expect(event?.attributes?.[RIUS_COMPACTION_SUMMARY_BYTES]).toBe(Buffer.byteLength(summary));
    expect(Object.hasOwn(event?.attributes ?? {}, RIUS_COMPACTION_SUMMARY_TEXT)).toBe(false);
    expect(event?.attributes?.[RIUS_COMPACTION_TOKENS_BEFORE]).toBe(100);
    expect(span.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
    expect(JSON.stringify(span.events)).not.toContain(summary);
  });

  it("a mask sees the summary text when content is captured", async () => {
    const seen: string[] = [];
    const span = await exportOne({
      captureContent: true,
      mask: (value, context) => {
        if (context?.key !== RIUS_COMPACTION_SUMMARY_TEXT) return value;
        seen.push(String(value));
        return "[masked]";
      },
    });
    const event = span.events.find((e) => e.name === RIUS_COMPACTION_EVENT);
    expect(seen).toEqual([summary]);
    expect(event?.attributes?.[RIUS_COMPACTION_SUMMARY_TEXT]).toBe("[masked]");
    expect(event?.attributes?.[RIUS_COMPACTION_SUMMARY_BYTES]).toBe(Buffer.byteLength(summary));
  });

  it("keeps the summary text unmasked by default", async () => {
    const span = await exportOne({});
    const event = span.events.find((e) => e.name === RIUS_COMPACTION_EVENT);
    expect(event?.attributes?.[RIUS_COMPACTION_SUMMARY_TEXT]).toBe(summary);
  });

  it("MaskingSpanExporter treats the event's summary text as content", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [
        new NormalizingSpanProcessor(),
        new SimpleSpanProcessor(new MaskingSpanExporter(exporter, { captureContent: false })),
      ],
    });
    provider
      .getTracer("t")
      .startSpan("llm", { attributes: { ...LLM, [OUTPUT_VALUE]: JSON.stringify(response) } })
      .end();
    const [span] = exporter.getFinishedSpans();
    expect(JSON.stringify(span.events)).not.toContain(summary);
    expect(span.events.some((e) => e.name === RIUS_COMPACTION_EVENT)).toBe(true);
    await provider.shutdown();
  });
});
