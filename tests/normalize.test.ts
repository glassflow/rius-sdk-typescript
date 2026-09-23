import type { AttributeValue, Attributes } from "@opentelemetry/api";
import { trace } from "@opentelemetry/api";
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, Span, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { init } from "../src/client.js";
import { MaskingSpanExporter } from "../src/masking.js";
import {
  type Converter,
  type NormalizationRule,
  NormalizingSpanProcessor,
  copy,
  jsonMember,
  sum,
  toInt,
  wrapInList,
} from "../src/normalize.js";
import { RIUS_SPAN_PENDING } from "../src/semconv.js";

/** An ended span carrying just an attribute bag; the bag is mutated in place. */
function endedSpan(attributes: Attributes): ReadableSpan {
  return { attributes } as unknown as ReadableSpan;
}

/** A starting span with the mutable surface the processor uses at onStart. */
function startingSpan(attributes: Attributes): Span {
  const bag = attributes as Record<string, AttributeValue>;
  return {
    attributes: bag,
    setAttribute(key: string, value: AttributeValue) {
      bag[key] = value;
      return this;
    },
  } as unknown as Span;
}

/** Runs a table over one bag at onEnd and hands the mutated bag back. */
function normalized(attributes: Attributes, rules: readonly NormalizationRule[]): Attributes {
  new NormalizingSpanProcessor(rules).onEnd(endedSpan(attributes));
  return attributes;
}

describe("converters", () => {
  it("copy passes the value through unchanged", () => {
    expect(copy(["gpt-4o"])).toBe("gpt-4o");
  });

  it("toInt parses strings, truncates numbers and rejects junk", () => {
    expect(toInt(["42"])).toBe(42);
    expect(toInt([" 42 "])).toBe(42);
    expect(toInt([42.9])).toBe(42);
    expect(toInt(["not a number"])).toBeUndefined();
    expect(toInt([true])).toBeUndefined();
  });

  it("wrapInList wraps a scalar and leaves a list alone", () => {
    expect(wrapInList(["stop"])).toEqual(["stop"]);
    expect(wrapInList([["stop"]])).toEqual(["stop"]);
  });

  it("jsonMember promotes a member, re-serializing structures", () => {
    const promote = jsonMember("messages");
    expect(promote(['{"messages":[{"role":"user"}],"other":1}'])).toBe('[{"role":"user"}]');
    expect(jsonMember("n")(['{"n":7}'])).toBe(7);
    expect(promote(['{"prompt":"hi"}'])).toBeUndefined(); // member absent
    expect(promote(["not json"])).toBeUndefined();
    expect(promote(["[1,2]"])).toBeUndefined(); // not an object
  });

  it("sum adds the present parts and rejects a non-numeric one", () => {
    expect(sum([10, "5"])).toBe(15);
    expect(sum([10])).toBe(10);
    expect(sum([10, "x"])).toBeUndefined();
    expect(sum([])).toBeUndefined();
  });
});

describe("the mapping contract", () => {
  const RULES: readonly NormalizationRule[] = [
    { source: "vendor.model", target: "gen_ai.request.model", convert: copy },
  ];

  it("maps a source key to its canonical target and deletes the source", () => {
    const attributes = normalized({ "vendor.model": "gpt-4o" }, RULES);
    expect(attributes["gen_ai.request.model"]).toBe("gpt-4o");
    expect("vendor.model" in attributes).toBe(false);
  });

  it("never overwrites a canonical key that is already present", () => {
    const attributes = normalized(
      { "vendor.model": "dialect", "gen_ai.request.model": "native" },
      RULES,
    );
    // Native wins...
    expect(attributes["gen_ai.request.model"]).toBe("native");
    // ...and the dialect still goes: one name for one fact on the wire.
    expect("vendor.model" in attributes).toBe(false);
  });

  it("leaves an unmapped key untouched", () => {
    const attributes = normalized({ "vendor.model": "gpt-4o", "vendor.other": "kept" }, RULES);
    expect(attributes["vendor.other"]).toBe("kept");
  });

  it("keeps the source when the converter yields nothing", () => {
    const attributes = normalized({ "vendor.tokens": "junk" }, [
      { source: "vendor.tokens", target: "gen_ai.usage.input_tokens", convert: toInt },
    ]);
    expect(attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(attributes["vendor.tokens"]).toBe("junk");
  });

  it("combines several sources into one target and deletes them all", () => {
    const attributes = normalized({ "vendor.a": 3, "vendor.b": 4 }, [
      { source: ["vendor.a", "vendor.b"], target: "gen_ai.usage.input_tokens", convert: sum },
    ]);
    expect(attributes["gen_ai.usage.input_tokens"]).toBe(7);
    expect("vendor.a" in attributes).toBe(false);
    expect("vendor.b" in attributes).toBe(false);
  });

  it("fires on a partially present multi-source rule", () => {
    const attributes = normalized({ "vendor.a": 3 }, [
      { source: ["vendor.a", "vendor.b"], target: "gen_ai.usage.input_tokens", convert: sum },
    ]);
    expect(attributes["gen_ai.usage.input_tokens"]).toBe(3);
  });
});

describe("the fast path", () => {
  it("does not alter, or even consult, a span with no source-prefix keys", () => {
    let calls = 0;
    const counting: Converter = (values) => {
      calls += 1;
      return values[0];
    };
    const attributes = normalized({ "gen_ai.request.model": "gpt-4o", "session.id": "s" }, [
      { source: "vendor.model", target: "gen_ai.request.model", convert: counting },
    ]);
    expect(calls).toBe(0);
    expect(attributes).toEqual({ "gen_ai.request.model": "gpt-4o", "session.id": "s" });
  });
});

describe("the start hook", () => {
  it("maps identity rules at onStart and skips the rest", () => {
    const attributes: Attributes = { "vendor.model": "gpt-4o", "vendor.tokens": "12" };
    new NormalizingSpanProcessor([
      { source: "vendor.model", target: "gen_ai.request.model", convert: copy, identity: true },
      { source: "vendor.tokens", target: "gen_ai.usage.input_tokens", convert: toInt },
    ]).onStart(startingSpan(attributes), {} as never);

    expect(attributes["gen_ai.request.model"]).toBe("gpt-4o");
    expect("vendor.model" in attributes).toBe(false);
    // Not identity: a token count is not knowable at start, so it waits for onEnd.
    expect(attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(attributes["vendor.tokens"]).toBe("12");
  });
});

class Capture implements SpanExporter {
  readonly spans: ReadableSpan[] = [];
  export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
    // snapshot the bag: normalization and masking both mutate in place
    for (const s of spans)
      this.spans.push({ ...s, attributes: { ...s.attributes } } as ReadableSpan);
    cb({ code: 0 });
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

let client: ReturnType<typeof init> | undefined;
afterEach(async () => {
  await client?.shutdown();
  client = undefined;
});

describe("ordering against masking", () => {
  const VERCEL_PROMPT = { "ai.prompt": '{"messages":[{"role":"user"}]}' };

  /** Normalize, then mask: the order init() wires. */
  it("maps the dialect content key before masking strips it", () => {
    const inner = new Capture();
    const span = endedSpan({ ...VERCEL_PROMPT });
    new NormalizingSpanProcessor().onEnd(span);
    new MaskingSpanExporter(inner, { captureContent: true, mask: () => "[REDACTED]" }).export(
      [span],
      () => {},
    );
    expect(inner.spans[0].attributes["gen_ai.input.messages"]).toBe("[REDACTED]");
  });

  /**
   * The failure this ordering exists to prevent, pinned explicitly: masking
   * first strips `ai.prompt` as content, the normalizer then finds nothing,
   * and the canonical key arrives empty.
   */
  it("reversed, the canonical key arrives empty", () => {
    const inner = new Capture();
    const span = endedSpan({ ...VERCEL_PROMPT });
    new MaskingSpanExporter(inner, { captureContent: false }).export([span], () => {});
    new NormalizingSpanProcessor().onEnd(span);
    expect(span.attributes["gen_ai.input.messages"]).toBeUndefined();
  });
});

describe("normalization through the real init() pipeline", () => {
  it("start-time mapping reaches the pending snapshot", async () => {
    const exporter = new Capture();
    client = init({ spanExporter: exporter, partialSpans: true, heartbeat: false });
    // The dialect key is not on the pending identity allowlist; its canonical
    // target is. Only the start hook can bridge that.
    trace
      .getTracer("t")
      .startSpan("llm", { attributes: { "llm.model_name": "gpt-4o" } })
      .end();
    await client.flush();

    const pending = exporter.spans.find((s) => s.attributes[RIUS_SPAN_PENDING] === true);
    expect(pending?.attributes["gen_ai.request.model"]).toBe("gpt-4o");
    expect(pending?.attributes["llm.model_name"]).toBeUndefined();
  });

  it("normalizes before masking: the mask sees the CANONICAL key", async () => {
    const exporter = new Capture();
    const keys: string[] = [];
    client = init({
      spanExporter: exporter,
      heartbeat: false,
      mask: (_value, context) => {
        if (context?.key !== undefined) keys.push(context.key);
        return "[REDACTED]";
      },
    });
    trace
      .getTracer("t")
      .startSpan("llm", { attributes: { "ai.prompt": '{"messages":[{"role":"user"}]}' } })
      .end();
    await client.flush();

    // Reversed, the mask would have been handed "ai.prompt" and the canonical
    // key would never have existed.
    expect(keys).toContain("gen_ai.input.messages");
    expect(keys).not.toContain("ai.prompt");
    expect(exporter.spans[0].attributes["gen_ai.input.messages"]).toBe("[REDACTED]");
  });

  it("normalizes before masking: captureContent:false strips the canonical key", async () => {
    const exporter = new Capture();
    client = init({ spanExporter: exporter, heartbeat: false, captureContent: false });
    trace
      .getTracer("t")
      .startSpan("llm", {
        attributes: {
          "ai.prompt": '{"messages":[{"role":"user"}]}',
          "llm.token_count.prompt": "12",
        },
      })
      .end();
    await client.flush();

    const attributes = exporter.spans[0].attributes;
    // The content key was mapped and then stripped: neither spelling survives.
    expect(attributes["ai.prompt"]).toBeUndefined();
    expect(attributes["gen_ai.input.messages"]).toBeUndefined();
    // ...while the non-content mapping on the same span proves the normalizer
    // ran at all, rather than masking having eaten its input first.
    expect(attributes["gen_ai.usage.input_tokens"]).toBe(12);
    expect(attributes["llm.token_count.prompt"]).toBeUndefined();
  });
});
