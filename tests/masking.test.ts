import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { MaskingSpanExporter, isContentKey } from "../src/masking.js";

function span(attributes: Record<string, unknown>): ReadableSpan {
  return { attributes } as unknown as ReadableSpan;
}

interface Bag {
  name?: string;
  attributes?: Record<string, unknown>;
}

/** A span carrying events and/or links as well as its own attributes. */
function richSpan(parts: {
  attributes?: Record<string, unknown>;
  events?: Bag[];
  links?: Bag[];
}): ReadableSpan {
  return {
    attributes: parts.attributes ?? {},
    events: parts.events,
    links: parts.links,
  } as unknown as ReadableSpan;
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

  it("replaces the value with a marker rather than propagating a throwing mask", () => {
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

describe("MaskingSpanExporter events and links", () => {
  it("strips content carried by an event attribute when captureContent is false", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: false }).export(
      [
        richSpan({
          events: [
            {
              name: "gen_ai.user.message",
              attributes: { "gen_ai.input.messages": "secret", "gen_ai.request.model": "gpt-4o" },
            },
          ],
        }),
      ],
      () => {},
    );
    const event = inner.seen[0].events[0];
    expect(event.attributes?.["gen_ai.input.messages"]).toBeUndefined();
    expect(event.attributes?.["gen_ai.request.model"]).toBe("gpt-4o");
  });

  it("strips content carried by a link attribute when captureContent is false", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: false }).export(
      [richSpan({ links: [{ attributes: { "input.value": "secret", "link.rank": 1 } }] })],
      () => {},
    );
    const link = inner.seen[0].links[0];
    expect(link.attributes?.["input.value"]).toBeUndefined();
    expect(link.attributes?.["link.rank"]).toBe(1);
  });

  it("keeps the exception event and its type but strips message and stacktrace", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: false }).export(
      [
        richSpan({
          events: [
            {
              name: "exception",
              attributes: {
                "exception.type": "BadRequestError",
                "exception.message": '400: {"messages":[{"content":"<PII>"}]}',
                "exception.stacktrace": "at call (<PII>)",
              },
            },
          ],
        }),
      ],
      () => {},
    );
    const events = inner.seen[0].events;
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("exception");
    expect(events[0].attributes?.["exception.type"]).toBe("BadRequestError");
    expect(events[0].attributes?.["exception.message"]).toBeUndefined();
    expect(events[0].attributes?.["exception.stacktrace"]).toBeUndefined();
  });

  it("keeps exception message and stacktrace under the default captureContent", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: true, mask: () => "[REDACTED]" }).export(
      [
        richSpan({
          events: [
            {
              name: "exception",
              attributes: { "exception.message": "boom", "exception.stacktrace": "at x" },
            },
          ],
        }),
      ],
      () => {},
    );
    const event = inner.seen[0].events[0];
    expect(event.attributes?.["exception.message"]).toBe("boom");
    expect(event.attributes?.["exception.stacktrace"]).toBe("at x");
  });

  it("applies a mask to event and link content attributes", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: true, mask: () => "[REDACTED]" }).export(
      [
        richSpan({
          events: [{ name: "gen_ai.choice", attributes: { "gen_ai.output.messages": "secret" } }],
          links: [{ attributes: { "output.value": "secret" } }],
        }),
      ],
      () => {},
    );
    expect(inner.seen[0].events[0].attributes?.["gen_ai.output.messages"]).toBe("[REDACTED]");
    expect(inner.seen[0].links[0].attributes?.["output.value"]).toBe("[REDACTED]");
  });

  it("leaves a span with no events or links alone", () => {
    const inner = new Capture();
    const attributes = { "input.value": "secret", "gen_ai.request.model": "gpt-4o" };
    new MaskingSpanExporter(inner, { captureContent: false }).export(
      [richSpan({ attributes })],
      () => {},
    );
    expect(inner.seen[0].events).toBeUndefined();
    expect(inner.seen[0].links).toBeUndefined();
    expect(inner.seen[0].attributes["input.value"]).toBeUndefined();
    expect(inner.seen[0].attributes["gen_ai.request.model"]).toBe("gpt-4o");
  });
});
