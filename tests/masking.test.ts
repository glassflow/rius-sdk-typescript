import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { MaskingSpanExporter, isContentKey } from "../src/masking.js";

function span(attributes: Record<string, unknown>): ReadableSpan {
  return { attributes } as unknown as ReadableSpan;
}

class Capture implements SpanExporter {
  seen: ReadableSpan[] = [];
  export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
    this.seen = spans;
    cb({ code: ExportResultCode.SUCCESS });
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

describe("isContentKey", () => {
  it("matches exact keys, prefixes and suffixes", () => {
    expect(isContentKey("input.value")).toBe(true);
    expect(isContentKey("llm.input_messages.0.message.content")).toBe(true);
    expect(isContentKey("retrieval.documents.0.document.content")).toBe(true);
    expect(isContentKey("gen_ai.request.model")).toBe(false);
    expect(isContentKey("retrieval.documents.0.document.score")).toBe(false);
  });
});

describe("MaskingSpanExporter", () => {
  it("strips content but keeps metadata when captureContent is false", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: false }).export(
      [span({ "input.value": "secret", "gen_ai.request.model": "gpt-4o" })],
      () => {},
    );
    expect(inner.seen[0].attributes["input.value"]).toBeUndefined();
    expect(inner.seen[0].attributes["gen_ai.request.model"]).toBe("gpt-4o");
  });

  it("applies a mask to content values only", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, {
      captureContent: true,
      mask: () => "[REDACTED]",
    }).export([span({ "output.value": "secret", "gen_ai.request.model": "gpt-4o" })], () => {});
    expect(inner.seen[0].attributes["output.value"]).toBe("[REDACTED]");
    expect(inner.seen[0].attributes["gen_ai.request.model"]).toBe("gpt-4o");
  });

  it("passes the key to a mask that wants it", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, {
      captureContent: true,
      mask: (_v, ctx) => `masked:${ctx?.key}`,
    }).export([span({ "input.value": "secret" })], () => {});
    expect(inner.seen[0].attributes["input.value"]).toBe("masked:input.value");
  });

  it("drops the attribute rather than propagating a throwing mask", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, {
      captureContent: true,
      mask: () => {
        throw new Error("bad mask");
      },
    }).export([span({ "input.value": "secret" })], () => {});
    expect(inner.seen[0].attributes["input.value"]).toBe("[mask error]");
  });

  it("strips a suffix-matched key while its sibling metadata attribute survives", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: false }).export(
      [
        span({
          "retrieval.documents.0.document.content": "secret text",
          "retrieval.documents.0.document.score": 0.87,
        }),
      ],
      () => {},
    );
    expect(inner.seen[0].attributes["retrieval.documents.0.document.content"]).toBeUndefined();
    expect(inner.seen[0].attributes["retrieval.documents.0.document.score"]).toBe(0.87);
  });

  it("passes through a span with no content attributes unchanged", () => {
    const inner = new Capture();
    const attributes = { "gen_ai.request.model": "gpt-4o", "http.status_code": 200 };
    new MaskingSpanExporter(inner, { captureContent: false }).export([span(attributes)], () => {});
    expect(inner.seen[0].attributes).toEqual(attributes);
  });
});
