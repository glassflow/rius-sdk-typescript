import { type Attributes, ROOT_CONTEXT } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  type Span,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTracer, init, type RiusClient } from "../src/client.js";
import { COMPACTION_OPERATION, CompactionFlagSpanProcessor } from "../src/compaction.js";
import { startGeneration } from "../src/generation.js";
import { markCompaction } from "../src/markCompaction.js";
import {
  GEN_AI_CONVERSATION_COMPACTED,
  GEN_AI_OPERATION_NAME,
  kindForOperation,
  OPENINFERENCE_SPAN_KIND,
  PENDING_IDENTITY_ATTRIBUTES,
  PENDING_IDENTITY_PREFIXES,
  RIUS_COMPACTION_EVENT,
  RIUS_COMPACTION_EXECUTOR,
  RIUS_COMPACTION_KIND,
  RIUS_COMPACTION_MESSAGES_COMPACTED,
  RIUS_COMPACTION_MESSAGES_KEPT,
  RIUS_COMPACTION_SUMMARY_BYTES,
  RIUS_COMPACTION_SUMMARY_TEXT,
  RIUS_COMPACTION_TOKENS_AFTER,
  RIUS_COMPACTION_TOKENS_BEFORE,
  RIUS_COMPACTION_TOKENS_DROPPED,
  RIUS_COMPACTION_TRIGGER,
  RIUS_SPAN_PENDING,
  SpanKind,
} from "../src/semconv.js";
import { MAX_ATTR_CHARS, TRUNCATION_MARKER } from "../src/serde.js";
import { startAsCurrentSpan, startSpan } from "../src/spans.js";

/**
 * markCompaction leaves a pending flag in the async context it ran in, and a
 * test body is not a context of its own: run each in a fresh one, so a flag
 * one test leaves cannot reach the next.
 */
function isolated(fn: () => Promise<void>): () => Promise<void> {
  return () =>
    new Promise<void>((resolve, reject) => {
      setImmediate(() => fn().then(resolve, reject));
    });
}

const LLM_ATTRIBUTES: Attributes = { [OPENINFERENCE_SPAN_KIND]: "LLM" };

function llmSpan(name: string): void {
  getTracer().startSpan(name, { attributes: LLM_ATTRIBUTES }).end();
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

let client: RiusClient | undefined;
let exporter: InMemorySpanExporter;

function testInit(options: Parameters<typeof init>[0] = {}): RiusClient {
  exporter = new InMemorySpanExporter();
  client = init({
    spanExporter: exporter,
    heartbeat: false,
    serviceName: "mark-compaction-test",
    ...options,
  });
  return client;
}

async function finished(): Promise<ReadableSpan[]> {
  await client?.flush();
  return exporter.getFinishedSpans();
}

/** The one span that is not the compaction marker. */
async function callSpan(): Promise<ReadableSpan> {
  const [span] = (await finished()).filter((s) => s.name !== "compaction");
  return span;
}

async function byName(): Promise<Map<string, ReadableSpan>> {
  return new Map((await finished()).map((span) => [span.name, span]));
}

afterEach(async () => {
  await client?.shutdown();
  client = undefined;
});

describe("the compaction operation", () => {
  it("is the one the registry maps to CHAIN", () => {
    expect(kindForOperation(COMPACTION_OPERATION)).toBe(SpanKind.CHAIN);
  });
});

describe("without an initialized client", () => {
  it(
    "does not throw",
    isolated(async () => {
      expect(() => markCompaction()).not.toThrow();
      expect(() => markCompaction({ kind: "truncate", summary: "x" })).not.toThrow();
    }),
  );
});

describe("markCompaction span", () => {
  it(
    "is a CHAIN compaction span with a client summarize event's attributes by default",
    isolated(async () => {
      testInit();
      markCompaction();
      const [span] = await finished();
      expect(span.name).toBe("compaction");
      expect(span.attributes).toEqual({
        [OPENINFERENCE_SPAN_KIND]: "CHAIN",
        [GEN_AI_OPERATION_NAME]: "compaction",
        [RIUS_COMPACTION_KIND]: "summarize",
        [RIUS_COMPACTION_EXECUTOR]: "client",
      });
    }),
  );

  it(
    "records every field it is given",
    isolated(async () => {
      testInit();
      markCompaction({
        kind: "clear_tool_results",
        trigger: "manual",
        tokensBefore: 150000,
        tokensAfter: 40000,
        messagesCompacted: 31,
        messagesKept: 6,
        summary: "héllo",
      });
      const [span] = await finished();
      expect(span.attributes).toEqual({
        [OPENINFERENCE_SPAN_KIND]: "CHAIN",
        [GEN_AI_OPERATION_NAME]: "compaction",
        [RIUS_COMPACTION_KIND]: "clear_tool_results",
        [RIUS_COMPACTION_EXECUTOR]: "client",
        [RIUS_COMPACTION_TRIGGER]: "manual",
        [RIUS_COMPACTION_TOKENS_BEFORE]: 150000,
        [RIUS_COMPACTION_TOKENS_AFTER]: 40000,
        [RIUS_COMPACTION_TOKENS_DROPPED]: 110000,
        [RIUS_COMPACTION_MESSAGES_COMPACTED]: 31,
        [RIUS_COMPACTION_MESSAGES_KEPT]: 6,
        [RIUS_COMPACTION_SUMMARY_BYTES]: Buffer.byteLength("héllo", "utf8"),
        [RIUS_COMPACTION_SUMMARY_TEXT]: "héllo",
      });
    }),
  );

  it(
    "accepts each kind and each trigger",
    isolated(async () => {
      testInit();
      for (const kind of [
        "summarize",
        "clear_tool_results",
        "clear_thinking",
        "truncate",
      ] as const) {
        markCompaction({ kind });
      }
      for (const trigger of ["auto", "manual"] as const) markCompaction({ trigger });
      const spans = await finished();
      expect(spans.map((s) => s.attributes[RIUS_COMPACTION_KIND])).toEqual([
        "summarize",
        "clear_tool_results",
        "clear_thinking",
        "truncate",
        "summarize",
        "summarize",
      ]);
      expect(spans.slice(4).map((s) => s.attributes[RIUS_COMPACTION_TRIGGER])).toEqual([
        "auto",
        "manual",
      ]);
    }),
  );

  it(
    "computes tokens.dropped only from both sizes with before not below after",
    isolated(async () => {
      testInit();
      markCompaction({ tokensBefore: 10, tokensAfter: 10 });
      markCompaction({ tokensBefore: 5, tokensAfter: 9 });
      markCompaction({ tokensBefore: 5 });
      markCompaction({ tokensAfter: 5 });
      markCompaction({ tokensBefore: 0, tokensAfter: 0 });
      const spans = await finished();
      expect(spans.map((s) => s.attributes[RIUS_COMPACTION_TOKENS_DROPPED])).toEqual([
        0,
        undefined,
        undefined,
        undefined,
        0,
      ]);
    }),
  );

  it(
    "records the summary's size and text, and an empty summary's size as zero",
    isolated(async () => {
      testInit();
      markCompaction({ summary: "" });
      const [span] = await finished();
      expect(span.attributes[RIUS_COMPACTION_SUMMARY_BYTES]).toBe(0);
      expect(span.attributes[RIUS_COMPACTION_SUMMARY_TEXT]).toBe("");
    }),
  );

  it(
    "is a child of the current span",
    isolated(async () => {
      testInit();
      await startAsCurrentSpan("turn", async () => {
        markCompaction();
      });
      const spans = await byName();
      const parent = spans.get("turn");
      const child = spans.get("compaction");
      expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
      expect(child?.spanContext().traceId).toBe(parent?.spanContext().traceId);
    }),
  );

  it(
    "is a root span when none is current",
    isolated(async () => {
      testInit();
      markCompaction();
      const [span] = await finished();
      expect(span.parentSpanContext).toBeUndefined();
    }),
  );

  it(
    "withholds the summary text under captureContent false and keeps its size",
    isolated(async () => {
      testInit({ captureContent: false });
      markCompaction({ summary: "SECRET" });
      const [span] = await finished();
      expect(span.attributes[RIUS_COMPACTION_SUMMARY_TEXT]).toBeUndefined();
      expect(span.attributes[RIUS_COMPACTION_SUMMARY_BYTES]).toBe(6);
    }),
  );
});

describe("the summary text", () => {
  it(
    "is set after the span starts, never in its creation attributes",
    isolated(async () => {
      testInit();
      const tracer = getTracer();
      const real = tracer.startSpan.bind(tracer);
      const atStart: Array<Attributes | undefined> = [];
      const spy = vi.spyOn(tracer, "startSpan").mockImplementation((name, options, context) => {
        atStart.push({ ...options?.attributes });
        return real(name, options, context);
      });
      try {
        markCompaction({ summary: "SECRET", tokensBefore: 10 });
      } finally {
        spy.mockRestore();
      }
      expect(atStart).toHaveLength(1);
      expect(atStart[0]).not.toHaveProperty(RIUS_COMPACTION_SUMMARY_TEXT);
      // The size is not content and may ride the start.
      expect(atStart[0]?.[RIUS_COMPACTION_SUMMARY_BYTES]).toBe(6);
      const [span] = await finished();
      expect(span.attributes[RIUS_COMPACTION_SUMMARY_TEXT]).toBe("SECRET");
    }),
  );

  it(
    "is capped like any attribute, and its size is the whole summary's",
    isolated(async () => {
      testInit();
      const long = "y".repeat(MAX_ATTR_CHARS + 10);
      markCompaction({ summary: long });
      const [span] = await finished();
      expect(span.attributes[RIUS_COMPACTION_SUMMARY_TEXT]).toBe(
        "y".repeat(MAX_ATTR_CHARS) + TRUNCATION_MARKER,
      );
      expect(span.attributes[RIUS_COMPACTION_SUMMARY_BYTES]).toBe(long.length);
    }),
  );

  it(
    "has a lone surrogate replaced",
    isolated(async () => {
      testInit();
      markCompaction({ summary: "a\ud800b" });
      const [span] = await finished();
      expect(span.attributes[RIUS_COMPACTION_SUMMARY_TEXT]).toBe("a\ufffdb");
    }),
  );
});

describe("markCompaction validation", () => {
  const invalid: Array<[string, Parameters<typeof markCompaction>[0]]> = [
    ["an unknown kind", { kind: "shrink" as never }],
    ["a prototype-chain kind", { kind: "constructor" as never }],
    ["a proto kind", { kind: "__proto__" as never }],
    ["a non-string kind", { kind: 3 as never }],
    ["an unknown trigger", { trigger: "scheduled" as never }],
    ["a prototype-chain trigger", { trigger: "toString" as never }],
    ["a negative tokensBefore", { tokensBefore: -1 }],
    ["a fractional tokensAfter", { tokensAfter: 1.5 }],
    ["a NaN messagesCompacted", { messagesCompacted: Number.NaN }],
    ["an infinite messagesKept", { messagesKept: Number.POSITIVE_INFINITY }],
    ["a string count", { tokensBefore: "10" as never }],
    ["a null count", { tokensBefore: null as never }],
    ["a non-string summary", { summary: 5 as never }],
    ["a null summary", { summary: null as never }],
  ];

  for (const [label, options] of invalid) {
    it(
      `throws a TypeError for ${label}, recording nothing and flagging nothing`,
      isolated(async () => {
        testInit();
        expect(() => markCompaction(options)).toThrow(TypeError);
        llmSpan("after");
        const spans = await finished();
        expect(spans.map((s) => s.name)).toEqual(["after"]);
        expect(spans[0].attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
      }),
    );
  }

  it(
    "names the offending option",
    isolated(async () => {
      testInit();
      expect(() => markCompaction({ kind: "shrink" as never })).toThrow(/kind/);
      expect(() => markCompaction({ tokensBefore: -1 })).toThrow(/tokensBefore/);
      expect(() => markCompaction({ summary: 5 as never })).toThrow(/summary must be a string/);
      expect(() => markCompaction(null as never)).toThrow(/options must be an object/);
    }),
  );

  it(
    "throws without a client too",
    isolated(async () => {
      expect(() => markCompaction({ kind: "shrink" as never })).toThrow(TypeError);
    }),
  );
});

describe("the next LLM span", () => {
  it(
    "is flagged compacted, once",
    isolated(async () => {
      testInit();
      markCompaction();
      llmSpan("first");
      llmSpan("second");
      const spans = await byName();
      expect(spans.get("first")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
      expect(spans.get("second")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
    }),
  );

  it(
    "is flagged when the operation name alone makes it an LLM span",
    isolated(async () => {
      testInit();
      markCompaction();
      getTracer()
        .startSpan("chat", { attributes: { [GEN_AI_OPERATION_NAME]: "chat" } })
        .end();
      const span = await callSpan();
      expect(span.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
    }),
  );

  it(
    "is flagged when it is a native generation",
    isolated(async () => {
      testInit();
      markCompaction();
      startGeneration({ model: "gpt-4o" }).end();
      const span = await callSpan();
      expect(span.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
    }),
  );

  it(
    "is flagged inside a span opened after the mark",
    isolated(async () => {
      testInit();
      markCompaction();
      await startAsCurrentSpan("turn", async () => {
        llmSpan("call");
      });
      const spans = await byName();
      expect(spans.get("call")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
      expect(spans.get("turn")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
    }),
  );

  it(
    "is flagged when the kind is set after the span starts, as the OpenInference tracer does",
    isolated(async () => {
      testInit();
      markCompaction();
      const late = getTracer().startSpan("late");
      late.setAttribute(OPENINFERENCE_SPAN_KIND, "LLM");
      late.end();
      llmSpan("after");
      const spans = await byName();
      expect(spans.get("late")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
      expect(spans.get("after")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
    }),
  );

  it(
    "leaves the mark when a span that sets its kind late turns out not to be an LLM span",
    isolated(async () => {
      testInit();
      markCompaction();
      const tool = getTracer().startSpan("tool");
      tool.setAttribute(OPENINFERENCE_SPAN_KIND, "TOOL");
      tool.end();
      llmSpan("call");
      const spans = await byName();
      expect(spans.get("tool")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
      expect(spans.get("call")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
    }),
  );

  it(
    "goes to the first of several late-kind LLM spans running at once to end",
    isolated(async () => {
      testInit();
      markCompaction();
      const outer = getTracer().startSpan("outer");
      const inner = getTracer().startSpan("inner");
      outer.setAttribute(OPENINFERENCE_SPAN_KIND, "LLM");
      inner.setAttribute(OPENINFERENCE_SPAN_KIND, "LLM");
      inner.end();
      outer.end();
      const spans = await byName();
      expect(spans.get("inner")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
      expect(spans.get("outer")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
    }),
  );

  it(
    "does not flag a late-kind span started in another context",
    isolated(async () => {
      testInit();
      const sibling = new Promise<void>((resolve) => {
        setImmediate(() => {
          const late = getTracer().startSpan("sibling");
          late.setAttribute(OPENINFERENCE_SPAN_KIND, "LLM");
          late.end();
          resolve();
        });
      });
      markCompaction();
      await sibling;
      const span = (await finished()).find((s) => s.name === "sibling");
      expect(span?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
    }),
  );

  it(
    "is flagged after an await, in the same flow",
    isolated(async () => {
      testInit();
      markCompaction();
      await tick();
      await Promise.resolve();
      llmSpan("later");
      const span = await callSpan();
      expect(span.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
    }),
  );

  it(
    "is not flagged on spans that are not LLM spans, which leave the mark for the LLM span",
    isolated(async () => {
      testInit();
      markCompaction();
      startSpan("tool", { toolName: "search" }).end();
      getTracer()
        .startSpan("embed", { attributes: { [OPENINFERENCE_SPAN_KIND]: "EMBEDDING" } })
        .end();
      getTracer()
        .startSpan("agent", { attributes: { [OPENINFERENCE_SPAN_KIND]: "AGENT" } })
        .end();
      markCompaction();
      llmSpan("call");
      const spans = await byName();
      for (const name of ["tool", "embed", "agent", "compaction"]) {
        expect(spans.get(name)?.attributes[GEN_AI_CONVERSATION_COMPACTED], name).toBeUndefined();
      }
      expect(spans.get("call")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
    }),
  );

  it(
    "is flagged again after a second mark",
    isolated(async () => {
      testInit();
      markCompaction();
      llmSpan("one");
      llmSpan("between");
      markCompaction();
      llmSpan("two");
      const spans = await byName();
      expect(spans.get("one")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
      expect(spans.get("between")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
      expect(spans.get("two")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
    }),
  );

  it(
    "is not flagged in a sibling context that did not mark",
    isolated(async () => {
      testInit();
      await Promise.all([
        (async () => {
          await tick();
          markCompaction();
          await tick();
          llmSpan("marked-flow");
        })(),
        (async () => {
          await tick();
          await tick();
          await tick();
          llmSpan("sibling-flow");
        })(),
      ]);
      const spans = await byName();
      expect(spans.get("marked-flow")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
      expect(spans.get("sibling-flow")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
    }),
  );

  it(
    "is not flagged in a sibling that started before the mark",
    isolated(async () => {
      testInit();
      const early = new Promise<void>((resolve) => {
        setImmediate(() => {
          setImmediate(() => {
            llmSpan("early-sibling");
            resolve();
          });
        });
      });
      await tick();
      markCompaction();
      await early;
      llmSpan("marked-flow");
      const spans = await byName();
      expect(spans.get("early-sibling")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
      expect(spans.get("marked-flow")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
    }),
  );

  it(
    "is flagged in the flow that marked, and not in a sibling that was already running",
    isolated(async () => {
      testInit();
      const convB = async () => {
        await tick();
        llmSpan("B2");
      };
      const convA = async () => {
        markCompaction();
        await tick();
        await tick();
        llmSpan("A2");
      };
      await Promise.all([convB(), convA()]);
      const spans = await byName();
      expect(spans.get("A2")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
      expect(spans.get("B2")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
    }),
  );

  it(
    "is flagged in the flow that marked, and not in a sibling, when an earlier mark left a flag in the parent",
    isolated(async () => {
      testInit();
      markCompaction();
      llmSpan("earlier");
      const convB = async () => {
        await tick();
        llmSpan("B2");
      };
      const convA = async () => {
        markCompaction();
        await tick();
        await tick();
        llmSpan("A2");
      };
      await Promise.all([convB(), convA()]);
      const spans = await byName();
      expect(spans.get("earlier")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
      expect(spans.get("A2")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
      expect(spans.get("B2")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
    }),
  );

  it(
    "flags the next call of each concurrent flow that marked, when the parent holds a spent flag",
    isolated(async () => {
      testInit();
      markCompaction();
      llmSpan("earlier");
      const conversation = async (name: string, ticks: number) => {
        await tick();
        markCompaction();
        for (let i = 0; i < ticks; i++) await tick();
        llmSpan(name);
      };
      await Promise.all([conversation("fast", 1), conversation("slow", 3)]);
      const spans = await byName();
      expect(spans.get("fast")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
      expect(spans.get("slow")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
    }),
  );

  it(
    "is not flagged with no mark",
    isolated(async () => {
      testInit();
      llmSpan("plain");
      const [span] = await finished();
      expect(span.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
    }),
  );
});

describe("the span's event limit through init", () => {
  it(
    "is the one the provider enforces on the span, so provider events stop where it would",
    isolated(async () => {
      const before = process.env.OTEL_SPAN_EVENT_COUNT_LIMIT;
      process.env.OTEL_SPAN_EVENT_COUNT_LIMIT = "2";
      try {
        testInit();
      } finally {
        if (before === undefined) delete process.env.OTEL_SPAN_EVENT_COUNT_LIMIT;
        else process.env.OTEL_SPAN_EVENT_COUNT_LIMIT = before;
      }
      const edit = {
        type: "clear_tool_uses_20250919",
        cleared_input_tokens: 10,
        cleared_tool_uses: 1,
      };
      const span = getTracer().startSpan("call", { attributes: LLM_ATTRIBUTES });
      span.setAttribute(
        "output.value",
        JSON.stringify({ context_management: { applied_edits: [edit, edit, edit] } }),
      );
      span.end();
      const [exported] = await finished();
      expect(exported.events.filter((e) => e.name === RIUS_COMPACTION_EVENT)).toHaveLength(2);
      expect(exported.droppedEventsCount).toBe(1);
    }),
  );
});

describe("the processor's memory of undecided spans", () => {
  function fakeSpan(spanId: string, attributes: Attributes = {}): Span {
    return {
      attributes,
      spanContext: () => ({ traceId: "t".repeat(32), spanId, traceFlags: 1 }),
      setAttribute: () => undefined,
    } as unknown as Span;
  }

  it(
    "forgets a span when it ends, whether or not it was an LLM span",
    isolated(async () => {
      const processor = new CompactionFlagSpanProcessor();
      const held = () => (processor as unknown as { undecided: Map<string, unknown> }).undecided;
      markCompaction();
      const bare = fakeSpan("a".repeat(16));
      const other = fakeSpan("b".repeat(16));
      processor.onStart(bare, ROOT_CONTEXT);
      processor.onStart(other, ROOT_CONTEXT);
      expect(held().size).toBe(2);
      // The same span as seen at its end: another object, the same identity.
      processor.onEnd({
        ...bare,
        attributes: { [OPENINFERENCE_SPAN_KIND]: "TOOL" },
      } as unknown as ReadableSpan);
      expect(held().size).toBe(1);
      processor.onEnd({
        ...other,
        attributes: { [OPENINFERENCE_SPAN_KIND]: "LLM" },
      } as unknown as ReadableSpan);
      expect(held().size).toBe(0);
    }),
  );

  it(
    "is bounded when spans never end, forgetting the oldest first",
    isolated(async () => {
      const processor = new CompactionFlagSpanProcessor(2);
      const held = () => (processor as unknown as { undecided: Map<string, unknown> }).undecided;
      markCompaction();
      const spans = ["a", "b", "c", "d"].map((c) => fakeSpan(c.repeat(16)));
      for (const span of spans) processor.onStart(span, ROOT_CONTEXT);
      expect(held().size).toBe(2);
      // The oldest were forgotten: ending one as an LLM span claims nothing.
      const ended = (span: Span) =>
        ({ ...span, attributes: { [OPENINFERENCE_SPAN_KIND]: "LLM" } }) as unknown as ReadableSpan;
      const first = ended(spans[0]);
      processor.onEnd(first);
      expect(first.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
      const last = ended(spans[3]);
      processor.onEnd(last);
      expect(last.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
    }),
  );

  it("has a default bound", () => {
    const processor = new CompactionFlagSpanProcessor();
    expect((processor as unknown as { maxUndecided: number }).maxUndecided).toBeGreaterThan(0);
  });
});

describe("pending snapshots", () => {
  class Capture implements SpanExporter {
    readonly spans: ReadableSpan[] = [];
    export(spans: ReadableSpan[], cb: (r: { code: number }) => void): void {
      for (const s of spans)
        this.spans.push({ ...s, attributes: { ...s.attributes } } as ReadableSpan);
      cb({ code: 0 });
    }
    async shutdown(): Promise<void> {}
    async forceFlush(): Promise<void> {}
  }

  it("the compacted flag is not an identity attribute", () => {
    expect(PENDING_IDENTITY_ATTRIBUTES.has(GEN_AI_CONVERSATION_COMPACTED)).toBe(false);
    expect(
      PENDING_IDENTITY_PREFIXES.some((prefix) => GEN_AI_CONVERSATION_COMPACTED.startsWith(prefix)),
    ).toBe(false);
  });

  it(
    "never rides a pending snapshot, and does ride the final span",
    isolated(async () => {
      const capture = new Capture();
      client = init({
        spanExporter: capture,
        partialSpans: true,
        heartbeat: false,
        serviceName: "mark-compaction-test",
      });
      markCompaction();
      llmSpan("call");
      await client.flush();
      const pending = capture.spans.filter(
        (s) => s.name === "call" && s.attributes[RIUS_SPAN_PENDING] === true,
      );
      const final = capture.spans.filter(
        (s) => s.name === "call" && s.attributes[RIUS_SPAN_PENDING] !== true,
      );
      expect(pending).toHaveLength(1);
      expect(final).toHaveLength(1);
      expect(pending[0].attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
      expect(final[0].attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
    }),
  );
});
