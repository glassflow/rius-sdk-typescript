// Media through the whole SDK: the generation helpers, OpenInference's
// flattened image items, native semconv parts, and the raw-payload strip over
// every string a span carries.

import type { Attributes, AttributeValue } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { type InitOptions, init, type RiusClient } from "../src/client.js";
import { startGeneration } from "../src/generation.js";
import { NormalizingSpanProcessor } from "../src/normalize.js";
import { startSpan } from "../src/spans.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR42mNgAAAAAgAB5Sfe/AAAAABJRU5ErkJggg==";
const PNG_BYTES = 67;

let exporter: InMemorySpanExporter;
let client: RiusClient | undefined;

function setUp(options: Partial<InitOptions> = {}) {
  exporter = new InMemorySpanExporter();
  client = init({ spanExporter: exporter, heartbeatTransport: async () => {}, ...options });
}
afterEach(async () => {
  await client?.shutdown();
  client = undefined;
});

function ended(attributes: Attributes, extra: Partial<ReadableSpan> = {}): ReadableSpan {
  return {
    attributes,
    events: [],
    links: [],
    status: { code: 0 },
    startTime: [1700000000, 0],
    endTime: [1700000001, 0],
    ...extra,
  } as unknown as ReadableSpan;
}

function normalized(input: Record<string, AttributeValue>): Record<string, AttributeValue> {
  const attributes: Attributes = structuredClone(input);
  new NormalizingSpanProcessor().onEnd(ended(attributes));
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined),
  ) as Record<string, AttributeValue>;
}

const blob = (extra: Record<string, unknown>) => ({ type: "blob", ...extra });

describe("the generation helpers", () => {
  it("write provider media items as semconv parts, with no bytes", async () => {
    setUp();
    const gen = startGeneration("chat", { model: "m" });
    gen.setInput([
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: "JVBERg==" },
          },
        ],
      },
    ]);
    gen.setOutput({
      role: "assistant",
      content: null,
      audio: { id: "audio_1", data: "UklGRg==", transcript: "Hello." },
    });
    gen.end();
    await client?.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(JSON.parse(String(span.attributes["gen_ai.input.messages"]))).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", content: "What is this?" },
          blob({
            modality: "image",
            mime_type: "image/png",
            byte_size: PNG_BYTES,
            stripped_reason: "not_captured",
          }),
          blob({
            modality: "document",
            mime_type: "application/pdf",
            byte_size: 4,
            stripped_reason: "not_captured",
          }),
        ],
      },
    ]);
    expect(JSON.parse(String(span.attributes["gen_ai.output.messages"]))).toEqual([
      {
        role: "assistant",
        parts: [
          blob({ modality: "audio", byte_size: 4, stripped_reason: "not_captured" }),
          { type: "text", content: "Hello." },
        ],
      },
    ]);
    expect(JSON.parse(String(span.attributes["rius.context.sizes"]))).toEqual({
      version: 1,
      input_messages: [
        {
          role: "user",
          parts: [
            { type: "text", bytes: 13 },
            { type: "blob", modality: "image", byte_size: PNG_BYTES },
            { type: "blob", modality: "document", byte_size: 4 },
          ],
        },
      ],
      output_messages: [
        {
          role: "assistant",
          parts: [
            { type: "blob", modality: "audio", byte_size: 4 },
            { type: "text", bytes: 6 },
          ],
        },
      ],
    });
  });

  it("map a Gemini message's parts and a bare image_generation_call output item", async () => {
    setUp();
    const gen = startGeneration("chat", { model: "m" });
    gen.setInput({
      role: "user",
      parts: [{ text: "Describe" }, { inline_data: { mime_type: "image/png", data: PNG } }],
    });
    gen.setOutput({ type: "image_generation_call", output_format: "png", result: PNG });
    gen.end();
    await client?.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(JSON.parse(String(span.attributes["gen_ai.input.messages"]))).toEqual([
      {
        role: "user",
        parts: [
          { text: "Describe" },
          blob({
            modality: "image",
            mime_type: "image/png",
            byte_size: PNG_BYTES,
            stripped_reason: "not_captured",
          }),
        ],
      },
    ]);
    expect(JSON.parse(String(span.attributes["gen_ai.output.messages"]))).toEqual([
      {
        role: "assistant",
        parts: [
          blob({
            modality: "image",
            mime_type: "image/png",
            byte_size: PNG_BYTES,
            stripped_reason: "not_captured",
          }),
        ],
      },
    ]);
  });

  it("strip a raw payload before the attribute cap, keeping the text around it", async () => {
    setUp();
    const span = startSpan("tool");
    const huge = "A".repeat(64 * 1024);
    span.setInput({ messages: [{ role: "user", content: `see data:image/png;base64,${huge}` }] });
    span.end();
    await client?.flush();
    expect(exporter.getFinishedSpans()[0].attributes["input.value"]).toBe(
      '{"messages":[{"role":"user","content":"see [stripped image/png 49152 bytes]"}]}',
    );
  });
});

describe("OpenInference image items", () => {
  const item = (fields: Record<string, string>) => {
    const out: Record<string, string> = { "llm.input_messages.0.message.role": "user" };
    for (const [field, value] of Object.entries(fields)) {
      out[`llm.input_messages.0.message.contents.0.message_content.${field}`] = value;
    }
    return out;
  };
  const parts = (attributes: Record<string, AttributeValue>) =>
    JSON.parse(String(normalized(attributes)["gen_ai.input.messages"]))[0].parts;

  it("make a blob of a data URL, a uri of an https URL", () => {
    expect(
      parts(item({ type: "image", "image.image.url": `data:image/png;base64,${PNG}` })),
    ).toEqual([
      blob({
        modality: "image",
        mime_type: "image/png",
        byte_size: PNG_BYTES,
        stripped_reason: "not_captured",
      }),
    ]);
    expect(parts(item({ type: "image", "image.image.url": "https://x.test/a.png" }))).toEqual([
      { type: "uri", modality: "image", uri: "https://x.test/a.png" },
    ]);
  });

  it("make a blob redacted upstream of __REDACTED__, an empty data URL and no url", () => {
    expect(parts(item({ type: "image", "image.image.url": "__REDACTED__" }))).toEqual([
      blob({ modality: "image", stripped_reason: "redacted_upstream" }),
    ]);
    expect(parts(item({ type: "image", "image.image.url": "data:None;url,None" }))).toEqual([
      blob({ modality: "image", stripped_reason: "redacted_upstream" }),
    ]);
    expect(
      parts(item({ type: "image", "image.media_type": "image/jpeg", "image.type": "base64" })),
    ).toEqual([
      blob({ modality: "image", mime_type: "image/jpeg", stripped_reason: "redacted_upstream" }),
    ]);
  });
});

describe("native media parts in the message keys", () => {
  it("lose a blob's content and take the modality from the mime type", () => {
    const messages = JSON.stringify([
      {
        role: "user",
        parts: [
          { type: "text", content: "Summarize." },
          { type: "blob", modality: "image", mime_type: "application/pdf", content: "JVBERg==" },
          { type: "uri", mime_type: "audio/wav", uri: "https://x.test/a.wav" },
        ],
      },
    ]);
    expect(normalized({ "gen_ai.input.messages": messages })).toEqual({
      "gen_ai.input.messages": JSON.stringify([
        {
          role: "user",
          parts: [
            { type: "text", content: "Summarize." },
            blob({
              modality: "document",
              mime_type: "application/pdf",
              byte_size: 4,
              stripped_reason: "not_captured",
            }),
            { type: "uri", modality: "audio", mime_type: "audio/wav", uri: "https://x.test/a.wav" },
          ],
        },
      ]),
    });
  });

  it("leave a message key with nothing to change byte for byte", () => {
    const messages = '[ {"role": "user", "parts": [ {"type": "text", "content": "hi"} ]} ]';
    expect(normalized({ "gen_ai.input.messages": messages })).toEqual({
      "gen_ai.input.messages": messages,
    });
  });

  it("strip system instruction blobs too", () => {
    const system = JSON.stringify([{ type: "blob", mime_type: "image/png", content: PNG }]);
    expect(normalized({ "gen_ai.system_instructions": system })).toEqual({
      "gen_ai.system_instructions": JSON.stringify([
        blob({
          modality: "image",
          mime_type: "image/png",
          byte_size: PNG_BYTES,
          stripped_reason: "not_captured",
        }),
      ]),
    });
  });
});

describe("the raw-payload strip at the end of normalization", () => {
  it("covers raw payloads, string arrays, events and links, and keeps every other byte", () => {
    const input = `{"model": "m",  "messages": [{"role": "user", "content": [{"type": "input_audio", "input_audio": {"data": "UklGRg==", "format": "wav"}}]}]}`;
    const attributes: Attributes = {
      "input.value": input,
      "output.value": "plain data:image/png;base64,QUFB text",
      "x.list": ["data:audio/wav;base64,UklGRg==", "keep"],
      "x.number": 3,
    };
    const eventAttributes: Attributes = { "x.event": "data:image/png;base64,QUFB" };
    const linkAttributes: Attributes = { "x.link": "DATA:image/gif;base64,QUFB" };
    new NormalizingSpanProcessor().onEnd(
      ended(attributes, {
        events: [{ name: "e", time: [0, 0], attributes: eventAttributes }],
        links: [{ context: {} as never, attributes: linkAttributes }],
      }),
    );
    expect(attributes).toEqual({
      "input.value": input.replace('"UklGRg=="', '"[stripped audio/wav 4 bytes]"'),
      "output.value": "plain [stripped image/png 3 bytes] text",
      "x.list": ["[stripped audio/wav 4 bytes]", "keep"],
      "x.number": 3,
    });
    expect(eventAttributes).toEqual({ "x.event": "[stripped image/png 3 bytes]" });
    expect(linkAttributes).toEqual({ "x.link": "[stripped image/gif 3 bytes]" });
  });

  it("replaces a Vercel Buffer left in ai.prompt with its size", () => {
    // Unreadable as a prompt (no role), so the Vercel pass leaves it in place.
    const prompt =
      '{"messages":[{"content":[{"type":"file","data":{"type":"Buffer","data":[37,80,68,70]},"mediaType":"application/pdf"}]}]}';
    expect(normalized({ "ai.prompt": prompt })["ai.prompt"]).toBe(
      '{"messages":[{"content":[{"type":"file","data":"[stripped application/pdf 4 bytes]","mediaType":"application/pdf"}]}]}',
    );
  });

  it("makes no part of a file in the caller's ai.prompt, keeping its text", () => {
    const out = normalized({
      "ai.operationId": "ai.generateText",
      "ai.prompt": JSON.stringify({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Summarize." },
              {
                type: "file",
                data: { type: "Buffer", data: [1, 2] },
                mediaType: "application/pdf",
              },
            ],
          },
        ],
      }),
    });
    expect(JSON.parse(String(out["gen_ai.input.messages"]))).toEqual([
      { role: "user", parts: [{ type: "text", content: "Summarize." }] },
    ]);
  });
});
