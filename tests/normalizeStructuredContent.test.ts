// Content attributes another instrumentation sets as structured values.
//
// The GenAI conventions now ask for gen_ai.input.messages,
// gen_ai.output.messages, gen_ai.system_instructions and
// gen_ai.tool.definitions to be maps and arrays rather than JSON strings.
// OpenTelemetry JS drops a mapping attribute when it is set, but keeps an
// array of primitives, and a span another library builds or edits on a path
// that does not validate can carry anything. The normalizer writes each such
// value as the JSON text this SDK writes for the same content, then treats it
// exactly as that string: its media parts are rebuilt and stripped, so no byte
// of a blob leaves. A span carrying the string and a span carrying the
// structured value end with the same attributes.

import type { Attributes, AttributeValue } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { replacement } from "../src/mediaParts.js";
import { NormalizingSpanProcessor } from "../src/normalize.js";
import { MAX_ATTR_CHARS } from "../src/serde.js";

const INPUT = "gen_ai.input.messages";
const OUTPUT = "gen_ai.output.messages";
const SYSTEM = "gen_ai.system_instructions";
const TOOLS = "gen_ai.tool.definitions";

const PNG = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);

function normalized(input: Record<string, unknown>): Record<string, AttributeValue> {
  const attributes = { ...input } as Attributes;
  const span = {
    attributes,
    events: [],
    links: [],
    status: { code: 0 },
    startTime: [1700000000, 0],
    endTime: [1700000001, 0],
  } as unknown as ReadableSpan;
  new NormalizingSpanProcessor().onEnd(span);
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined),
  ) as Record<string, AttributeValue>;
}

const MESSAGES = [
  { role: "user", parts: [{ type: "text", content: "Weather in Paris? <b>&</b> é" }] },
  {
    role: "assistant",
    parts: [
      {
        type: "tool_call",
        id: "call_1",
        name: "get_weather",
        arguments: { city: "Paris", days: 2 },
      },
    ],
  },
];

describe("a structured content key", () => {
  for (const key of [INPUT, OUTPUT, SYSTEM]) {
    it(`${key} is written as its JSON`, () => {
      const value = key === SYSTEM ? MESSAGES[0].parts : MESSAGES;
      expect(normalized({ [key]: value })[key]).toBe(JSON.stringify(value));
    });
  }

  it("gen_ai.tool.definitions is written as its JSON", () => {
    const tools = [
      {
        type: "function",
        name: "get_weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    ];
    expect(normalized({ [TOOLS]: tools })[TOOLS]).toBe(JSON.stringify(tools));
  });

  it("exports as its JSON string does, a blob's bytes included", () => {
    const message = (content: unknown) => [
      {
        role: "user",
        parts: [
          { type: "text", content: "describe" },
          { type: "blob", modality: "image", mime_type: "image/png", content },
        ],
      },
    ];
    const structured = normalized({ [INPUT]: message(PNG), other: "x" });
    const asString = normalized({
      [INPUT]: JSON.stringify(message(Buffer.from(PNG).toString("base64"))),
      other: "x",
    });
    expect(structured).toEqual(asString);
    const parts = JSON.parse(structured[INPUT] as string)[0].parts;
    expect(parts[1]).toEqual({
      type: "blob",
      modality: "image",
      mime_type: "image/png",
      byte_size: 8,
      stripped_reason: "not_captured",
    });
  });

  it("loses a blob's bytes in the system instructions and tool definitions", () => {
    const blob = { type: "blob", mime_type: "image/png", content: PNG };
    const out = normalized({ [SYSTEM]: [blob], [TOOLS]: [blob] });
    const encoded = Buffer.from(PNG).toString("base64");
    for (const key of [SYSTEM, TOOLS]) {
      expect(out[key]).not.toContain(encoded);
      expect(JSON.parse(out[key] as string)[0].type).toBe("blob");
    }
  });

  it("reads a blob's content from any byte object", () => {
    const view = new DataView(new Uint8Array([9, ...PNG, 9]).buffer, 1, 8);
    for (const content of [PNG.buffer, Buffer.from(PNG), view]) {
      const out = normalized({ [SYSTEM]: [{ type: "blob", mime_type: "image/png", content }] });
      expect(JSON.parse(out[SYSTEM] as string)[0].byte_size).toBe(8);
    }
  });

  it("keeps the rest of the value when a blob's bytes cannot be read", () => {
    const detached = new ArrayBuffer(16);
    structuredClone(detached, { transfer: [detached] });
    const out = normalized({
      [OUTPUT]: [
        {
          role: "assistant",
          parts: [
            { type: "text", content: "keep me" },
            { type: "blob", mime_type: "image/png", content: detached },
          ],
        },
      ],
    });
    // As the Python SDK writes a blob whose bytes it cannot read: the part
    // without its content and without a size.
    expect(JSON.parse(out[OUTPUT] as string)[0].parts).toEqual([
      { type: "text", content: "keep me" },
      { type: "blob", modality: "image", mime_type: "image/png", stripped_reason: "not_captured" },
    ]);
  });

  it("never leaks a blob's bytes from a value it cannot encode plainly", () => {
    const image = new Uint8Array(10240).map((_, i) => i % 256);
    const encoded = Buffer.from(image).toString("base64").slice(0, 64);
    const blob = { type: "blob", mime_type: "image/png", content: image };
    const cycle: Record<string, unknown>[] = [{ role: "user", parts: [blob] }];
    (cycle[0] as Record<string, unknown>).self = cycle;
    const byteKeyed = [
      new Map<unknown, unknown>([
        [PNG, 1],
        ["parts", [blob]],
      ]),
    ];
    for (const value of [cycle, byteKeyed]) {
      const text = normalized({ [INPUT]: value })[INPUT] as string;
      // The encoder's own cycle and Map handling keep the value JSON, so the
      // blob is still rebuilt and stripped.
      expect(text).not.toContain(encoded);
      expect(text).toContain('"byte_size":10240,"stripped_reason":"not_captured"');
    }
  });

  it("writes any other byte object as the marker", () => {
    const out = normalized({
      [OUTPUT]: [{ role: "assistant", parts: [{ type: "x", data: PNG }] }],
    });
    expect(JSON.parse(out[OUTPUT] as string)[0].parts[0]).toEqual({
      type: "x",
      data: replacement(undefined, 8),
    });
  });

  it("writes a Map as an object", () => {
    const value = [
      new Map([
        ["type", "text"],
        ["content", "hi"],
      ]),
    ];
    expect(normalized({ [SYSTEM]: value })[SYSTEM]).toBe('[{"type":"text","content":"hi"}]');
  });

  it("writes a non-finite number inside as null", () => {
    const tools = [
      { name: "t", parameters: { default: Number.NaN, max: Number.POSITIVE_INFINITY } },
    ];
    expect(normalized({ [TOOLS]: tools })[TOOLS]).toBe(
      '[{"name":"t","parameters":{"default":null,"max":null}}]',
    );
  });

  it("writes an array of strings as its JSON array", () => {
    expect(normalized({ [SYSTEM]: ["be brief", "be kind"] })[SYSTEM]).toBe(
      '["be brief","be kind"]',
    );
  });

  it("is not cut at the attribute cap", () => {
    const text = "word ".repeat(MAX_ATTR_CHARS / 2);
    const value = [{ role: "user", parts: [{ type: "text", content: text }] }];
    const out = normalized({ [INPUT]: value });
    expect(out[INPUT]).toBe(JSON.stringify(value));
    expect(out).toEqual(normalized({ [INPUT]: JSON.stringify(value) }));
  });

  it("never fails the span when it cannot be encoded", () => {
    const cycle: unknown[] = [{ type: "text", content: "hi" }];
    cycle.push(cycle);
    const throwing = {
      get content() {
        throw new Error("boom");
      },
    };
    const out = normalized({ [INPUT]: cycle, [OUTPUT]: [throwing], other: "x" });
    expect(typeof out[INPUT]).toBe("string");
    expect(typeof out[OUTPUT]).toBe("string");
    expect(out.other).toBe("x");
  });
});

describe("a value that is not structured", () => {
  for (const value of ["already text", 3, true]) {
    it(`keeps ${JSON.stringify(value)}`, () => {
      expect(normalized({ [INPUT]: value })[INPUT]).toBe(value);
    });
  }

  it("writes a lone byte object as the marker, as the Python SDK does", () => {
    for (const bytes of [PNG, Buffer.from(PNG), PNG.buffer]) {
      expect(normalized({ [INPUT]: bytes })[INPUT]).toBe(replacement(undefined, 8));
    }
  });

  it("keeps a structured value under any other key", () => {
    expect(normalized({ "app.payload": { a: [1, 2] } })["app.payload"]).toEqual({ a: [1, 2] });
  });
});
