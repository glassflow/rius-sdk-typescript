// Media through the whole SDK: the generation helpers, OpenInference's
// flattened image items, native semconv parts, and the raw-payload strip over
// every string a span carries.

import type { Attributes, AttributeValue } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { type InitOptions, init, type RiusClient } from "../src/client.js";
import { startGeneration } from "../src/generation.js";
import { rebuildNativeMediaParts, stripRawPayload } from "../src/mediaParts.js";
import { NormalizingSpanProcessor, normalizeNativeMediaParts } from "../src/normalize.js";
import { startSpan } from "../src/spans.js";
import { afterFirstReturn, upFromStackBottom } from "./stack.js";

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

describe("native media parts are rebuilt in place", () => {
  const BLOB =
    '{"type":"blob","modality":"image","mime_type":"image/png","byte_size":3,"stripped_reason":"not_captured"}';

  it("replace only the part's token, keeping every other byte of spaced input", () => {
    const messages =
      '[ {"role": "user", "parts": [ {"type": "blob", "content": "QUJD", "mime_type": "image/png"} ] } ]';
    expect(normalized({ "gen_ai.input.messages": messages })).toEqual({
      "gen_ai.input.messages": `[ {"role": "user", "parts": [ ${BLOB} ] } ]`,
    });
  });

  it("in the output messages and the system instructions too", () => {
    const output =
      '[ {"role": "assistant", "parts": [ {"type": "text", "content": "x"}, {"type": "blob", "content": "QUJD", "mime_type": "image/png"} ], "finish_reason": "stop"} ]';
    const system =
      '[ {"type": "text", "content": "Be brief."},\n  {"type": "blob", "content": "QUJD", "mime_type": "image/png"} ]';
    expect(
      normalized({ "gen_ai.output.messages": output, "gen_ai.system_instructions": system }),
    ).toEqual({
      "gen_ai.output.messages": `[ {"role": "assistant", "parts": [ {"type": "text", "content": "x"}, ${BLOB} ], "finish_reason": "stop"} ]`,
      "gen_ai.system_instructions": `[ {"type": "text", "content": "Be brief."},\n  ${BLOB} ]`,
    });
  });

  it("leave a value with nothing to rebuild, or that does not parse, byte for byte", () => {
    const attributes = {
      "gen_ai.input.messages":
        '[ {"role": "user", "parts": [ {"type": "text", "content": "caf\\u00e9"} ] } ]',
      "gen_ai.output.messages":
        '[ {"role": "user", "parts": [ {"type": "blob", "content": "QUJD"} ]',
      "gen_ai.system_instructions": '[ {"type": "text", "content": "x"} ]',
    };
    expect(normalized({ ...attributes })).toEqual(attributes);
  });

  it("keep a number's spelling, and rebuild an empty uri or file_id as a target", () => {
    const messages =
      '[ {"role": "user", "parts": [ {"type": "blob", "content": "QUJD", "mime_type": "image/png"}, {"type": "uri", "uri": ""}, {"type": "file", "file_id": ""}, {"type": "file"} ], "score": 1.50 } ]';
    const attributes: Record<string, AttributeValue> = { "gen_ai.input.messages": messages };
    normalizeNativeMediaParts(attributes);
    expect(attributes).toEqual({
      "gen_ai.input.messages": `[ {"role": "user", "parts": [ ${BLOB}, {"type":"uri","modality":"document","uri":""}, {"type":"file","modality":"document","file_id":""}, {"type": "file"} ], "score": 1.50 } ]`,
    });
  });

  it("reach parts in a message nested past the strip's depth, and never overflow the stack", () => {
    const part = '{"type": "blob", "content": "QUJD", "mime_type": "image/png"}';
    const nested = (depth: number) =>
      `[{"role": "user", "x": ${"[".repeat(depth)}${"]".repeat(depth)}, "parts": [${part}]}]`;
    const attributes: Record<string, AttributeValue> = {
      "gen_ai.input.messages": nested(500),
      "gen_ai.output.messages": nested(20000),
    };
    normalizeNativeMediaParts(attributes);
    expect(attributes).toEqual({
      "gen_ai.input.messages": nested(500).replace(part, BLOB),
      "gen_ai.output.messages": nested(20000),
    });
  });

  it("rebuild a value 1000 levels deep and leave one 1001 levels deep as it came", () => {
    const part = '{"type": "blob", "content": "QUJD", "mime_type": "image/png"}';
    // The outer array and the message are two levels; the arrays under "x" the rest.
    const levels = (depth: number) =>
      `[{"role": "user", "x": ${"[".repeat(depth - 2)}${"]".repeat(depth - 2)}, "parts": [${part}]}]`;
    const attributes: Record<string, AttributeValue> = {
      "gen_ai.input.messages": levels(1000),
      "gen_ai.output.messages": levels(1001),
    };
    normalizeNativeMediaParts(attributes);
    expect(attributes).toEqual({
      "gen_ai.input.messages": levels(1000).replace(part, BLOB),
      "gen_ai.output.messages": levels(1001),
    });
  });

  it("leave a value as it came, never throwing, when the stack left cannot hold its depth", () => {
    const part = '{"type": "blob", "content": "QUJD", "mime_type": "image/png"}';
    const value = `[{"role": "user", "x": ${"[".repeat(998)}${"]".repeat(998)}, "parts": [${part}]}]`;
    const rebuilt = value.replace(part, BLOB);
    const results = afterFirstReturn(upFromStackBottom(() => rebuildNativeMediaParts(value, true)));
    expect(new Set(results)).toEqual(new Set([value, rebuilt]));
    expect(results.at(-1)).toBe(rebuilt);
  });

  it("count levels as the sink does: a blob beside a tool call nested to 1000 is rebuilt, to 1001 is not", () => {
    // The message array, the message, its parts and the tool call are four levels.
    const value = (levels: number) =>
      `[{"role":"user","parts":[{"type":"blob","modality":"image","content":"QUFB"},` +
      `{"type":"tool_call","arguments":${"[".repeat(levels - 4)}${"]".repeat(levels - 4)}}]}]`;
    expect(rebuildNativeMediaParts(value(1000), true)).not.toBe(value(1000));
    expect(rebuildNativeMediaParts(value(1001), true)).toBe(value(1001));
  });

  it("leave a part as it came when it rebuilds into no parts at all", () => {
    const text = '{"type": "text", "content": "x"}';
    const media = '{"type": "blob", "content": "QUJD"}';
    const value = `[{"role": "user", "parts": [${text}, ${media}, ${text}]}]`;
    // No part rebuilds into nothing today; an empty list joined would leave `[a,,b]`.
    const none = (part: Record<string, unknown>) => (part.type === "blob" ? [] : undefined);
    expect(rebuildNativeMediaParts(value, true, none)).toBe(value);
  });

  it("let an error that is not the stack running out propagate", () => {
    const value = '[{"role": "user", "parts": [{"type": "blob", "content": "QUJD"}]}]';
    const broken = () => {
      throw new RangeError("Invalid array length");
    };
    expect(() => rebuildNativeMediaParts(value, true, broken)).toThrow("Invalid array length");
  });

  it("read a message's parts last-member-wins", () => {
    const first = '{"type": "blob", "content": "QUJD", "mime_type": "image/png"}';
    const messages = `[{"role": "user", "parts": [${first}], "parts": [${first}]}]`;
    const attributes: Record<string, AttributeValue> = { "gen_ai.input.messages": messages };
    normalizeNativeMediaParts(attributes);
    expect(attributes).toEqual({
      "gen_ai.input.messages": `[{"role": "user", "parts": [${first}], "parts": [${BLOB}]}]`,
    });
  });

  it("read a part's type last-member-wins", () => {
    const messages =
      '[{"role": "user", "parts": [{"type": "text", "type": "blob", "content": "QUJD", "mime_type": "image/png"}, {"type": "blob", "type": "text", "content": "Look."}]}]';
    // The rebuild alone: the raw-payload strip after it reads any `type` member.
    const attributes: Record<string, AttributeValue> = { "gen_ai.input.messages": messages };
    normalizeNativeMediaParts(attributes);
    expect(attributes).toEqual({
      "gen_ai.input.messages": `[{"role": "user", "parts": [${BLOB}, {"type": "blob", "type": "text", "content": "Look."}]}]`,
    });
  });
});

describe("a native message key's file parts, read as the SDKs and the sink read them", () => {
  // Each part alone in a user message, rebuilt and then stripped as the exporter does.
  // A type-file object with a string base64 or url is a LangChain v1 file block.
  it.each([
    [
      '{"type":"file","url":" data:image/png;base64,iVBO\\nRw0KGgo="}',
      '{"type":"blob","modality":"document","stripped_reason":"not_captured"}',
    ],
    [
      '{"type":"file","url":"https://x/a.png\\ndata:image/png;base64,iVBO\\nRw0KGgo="}',
      '{"type":"blob","modality":"document","stripped_reason":"not_captured"}',
    ],
    [
      '{"type":"file","file_id":"","url":"https://x/a.pdf"}',
      '{"type":"uri","modality":"document","uri":"https://x/a.pdf"}',
    ],
    [
      '{"type":"file","file_id":5,"url":"https://x/a.wav"}',
      '{"type":"uri","modality":"audio","uri":"https://x/a.wav"}',
    ],
    [
      '{"type":"file","file_id":"__REDACTED__","base64":"QUFB"}',
      '{"type":"blob","modality":"document","byte_size":3,"stripped_reason":"not_captured"}',
    ],
    ['{"type":"file","file_id":5}', '{"type":"file","file_id":5}'],
    ['{"type":"file","file_id":"f-1"}', '{"type":"file","modality":"document","file_id":"f-1"}'],
    [
      '{"type":"file","file_id":"f-1","modality":"image","mime_type":"application/pdf","extra":1}',
      '{"type":"file","modality":"image","mime_type":"application/pdf","file_id":"f-1"}',
    ],
    [
      '{"type":"file","file_id":"f-1","url":"https://x/a.png"}',
      '{"type":"file","modality":"document","file_id":"f-1"}',
    ],
    [
      '{"type":"file","file_id":"f-1","base64":"QUFB"}',
      '{"type":"file","modality":"document","file_id":"f-1"}',
    ],
    [
      '{"type":"file","file_id":"f-1","base64":""}',
      '{"type":"file","modality":"document","file_id":"f-1"}',
    ],
    [
      '{"type":"file","base64":"QUFB","mime_type":"audio/wav"}',
      '{"type":"blob","modality":"audio","mime_type":"audio/wav","byte_size":3,"stripped_reason":"not_captured"}',
    ],
    [
      '{"type":"file","url":"data:application/pdf;base64,QUFB"}',
      '{"type":"blob","modality":"document","mime_type":"application/pdf","byte_size":3,"stripped_reason":"not_captured"}',
    ],
    [
      '{"type":"file","url":"__REDACTED__"}',
      '{"type":"blob","modality":"document","stripped_reason":"redacted_upstream"}',
    ],
    [
      '{"type":"file","url":""}',
      '{"type":"blob","modality":"document","stripped_reason":"redacted_upstream"}',
    ],
    [
      '{"type":"file","url":"","file_id":"__REDACTED__"}',
      '{"type":"file","modality":"document","file_id":"__REDACTED__"}',
    ],
    [
      '{"type":"file","url":"https://x/a.mp4","mime_type":"video/mp4"}',
      '{"type":"uri","modality":"video","mime_type":"video/mp4","uri":"https://x/a.mp4"}',
    ],
    [
      '{"type":"file","url":5,"file_id":"f-2"}',
      '{"type":"file","modality":"document","file_id":"f-2"}',
    ],
    ['{"type":"file","file":{"file_id":"f-3"}}', '{"type":"file","file":{"file_id":"f-3"}}'],
    [
      '{"type":"blob","modality":"image","content":"QUFB"}',
      '{"type":"blob","modality":"image","byte_size":3,"stripped_reason":"not_captured"}',
    ],
    [
      '{"type":"uri","uri":" data:image/png;base64,iVBO\\nRw0KGgo="}',
      '{"type":"blob","modality":"document","stripped_reason":"not_captured"}',
    ],
    [
      '{"type":"uri","modality":"audio","uri":"https://x/a"}',
      '{"type":"uri","modality":"audio","uri":"https://x/a"}',
    ],
  ])("%s becomes %s", (part, expected) => {
    const attributes: Record<string, AttributeValue> = {
      "gen_ai.input.messages": `[{"role":"user","parts":[${part}]}]`,
    };
    normalizeNativeMediaParts(attributes);
    expect(stripRawPayload(attributes["gen_ai.input.messages"] as string)).toBe(
      `[{"role":"user","parts":[${expected}]}]`,
    );
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

  it("strips a Vercel image's base64 and tagged data left in ai.prompt, keeping links", () => {
    const prompt = JSON.stringify({
      messages: [
        {
          content: [
            { type: "image", image: "iVBORw0KGgo=", mediaType: "image/png" },
            { type: "image", image: "https://x.test/a.png" },
            {
              type: "file",
              data: { type: "data", data: "JVBERi0=" },
              mediaType: "application/pdf",
            },
            { type: "file", data: { type: "data", data: "gs://bucket/a.pdf" } },
          ],
        },
      ],
    });
    expect(normalized({ "ai.prompt": prompt })["ai.prompt"]).toBe(
      prompt
        .replace('"iVBORw0KGgo="', '"[stripped image/png 8 bytes]"')
        .replace('"JVBERi0="', '"[stripped application/pdf 5 bytes]"'),
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

describe("audio usage", () => {
  it("maps OpenInference's audio details to the audio subsets, leaving the totals as they are", () => {
    expect(
      normalized({
        "llm.token_count.prompt": 42,
        "llm.token_count.completion": 9,
        "llm.token_count.prompt_details.audio": 30,
        "llm.token_count.completion_details.audio": 5,
      }),
    ).toEqual({
      "gen_ai.usage.input_tokens": 42,
      "gen_ai.usage.output_tokens": 9,
      "gen_ai.usage.audio.input_tokens": 30,
      "gen_ai.usage.audio.output_tokens": 5,
    });
  });

  it("maps @ai-sdk/otel's input_token_details.audio_tokens, keeping text_tokens", () => {
    expect(
      normalized({
        "gen_ai.usage.input_tokens": 14,
        "gen_ai.usage.input_token_details.audio_tokens": 14,
        "gen_ai.usage.input_token_details.text_tokens": 0,
      }),
    ).toEqual({
      "gen_ai.usage.input_tokens": 14,
      "gen_ai.usage.audio.input_tokens": 14,
      "gen_ai.usage.input_token_details.text_tokens": 0,
    });
  });

  it("leaves pydantic-ai's details.audio_tokens, which names no direction", () => {
    expect(normalized({ "gen_ai.usage.details.audio_tokens": 3 })).toEqual({
      "gen_ai.usage.details.audio_tokens": 3,
    });
  });
});
