import { randomBytes } from "node:crypto";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { stripSpanPayloads } from "../src/normalize.js";
import { textValue, toAttributeValue } from "../src/serde.js";

// The media strip's parser gives up past its depth limit, so a text nested
// deeper is not JSON to it and only its data URLs are found: a keyed image's
// base64 would leave the SDK whole. A text that deep gets a fallback that
// replaces every long run of the base64 alphabet, as the Python SDK does.

function image(data: string): Record<string, unknown> {
  return { type: "image", source: { type: "base64", media_type: "image/png", data } };
}

function nested(value: unknown, depth: number): unknown {
  let current = value;
  for (let i = 0; i < depth; i++) current = { x: current };
  return current;
}

const data = randomBytes(3000).toString("base64");
const head = data.slice(0, 64);

describe("keyed base64 nested past the media parser's depth", () => {
  it.each([70, 200])("is stripped from a value nested %i deep", (depth) => {
    expect(toAttributeValue(nested(image(data), depth))).not.toContain(head);
  });

  it("is stripped from text another instrumentation rendered", () => {
    const deep = '{"x":'.repeat(100) + JSON.stringify(image(data)) + "}".repeat(100);
    expect(textValue(deep)).not.toContain(head);
  });

  it.each([
    [1, 70],
    [40, 30],
  ])("is stripped from a JSON string %i deep holding %i more levels", (outer, inner) => {
    // The parser re-parses a JSON-looking string at the depth it sits at, so
    // the depth inside the string adds to the depth around it.
    const value = nested({ s: JSON.stringify(nested(image(data), inner)) }, outer - 1);
    expect(toAttributeValue(value)).not.toContain(head);
    expect(textValue(JSON.stringify(value))).not.toContain(head);
  });

  it("is stripped from a span attribute at export", () => {
    const deep = JSON.stringify(nested(image(data), 70));
    const span = { attributes: { "input.value": deep }, events: [], links: [] };
    stripSpanPayloads(span as unknown as ReadableSpan);
    expect(span.attributes["input.value"]).not.toContain(head);
  });
});

describe("text within the parser's depth", () => {
  it("keeps a long word", () => {
    const word = "a".repeat(200);
    expect(toAttributeValue({ x: { y: word } })).toContain(word);
  });

  it("keeps a long word when brackets exceed the depth but no path does", () => {
    const word = "a".repeat(200);
    const value = {
      a: nested({ s: JSON.stringify(nested({ w: word }, 20)) }, 39),
      b: nested(1, 30),
    };
    expect(toAttributeValue(value)).toContain(word);
  });

  it("is written byte for byte as before below the depth", () => {
    // A shallow image is the contract's strip alone: the fallback never runs.
    const shallow = nested(image(data), 10);
    const text = toAttributeValue(shallow);
    expect(text).not.toContain(head);
    expect(text).toContain('"media_type":"image/png"');
  });
});
