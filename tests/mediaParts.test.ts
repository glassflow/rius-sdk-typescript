// The raw-payload strip against rius-semconv's golden examples, and the media
// part mappings of registry/media_parts.yaml (synced into
// tests/fixtures/semconv/media_parts.json by scripts/sync-semconv-fixtures.sh).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUFFER_RULE,
  base64Size,
  blobPart,
  DATA_URL_PATTERN,
  EXTENSION_MODALITY,
  fileIdPart,
  isReplacement,
  KEYED_RULE,
  MAX_DEPTH,
  type MediaToken,
  MIME_PATTERN,
  providerMediaParts,
  REPLACEMENT_FORMAT,
  REPLACEMENT_UNKNOWN,
  strip,
  stripRawPayload,
  uriPart,
} from "../src/mediaParts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
type GoldenToken = { rule: string; mime: string; byte_size: number | string };
type Golden = {
  name: string;
  input: string;
  output: string;
  tokens: GoldenToken[];
  // Present only where a second pass changes the output (see idempotence).
  second_output?: string;
  second_tokens?: GoldenToken[];
};
type Rule = Record<string, unknown> & { id: string };
type TypedKey = {
  key: string;
  types: string[];
  parent_keys?: string[];
  keeps_urls?: boolean;
  holder_mime?: boolean;
};
const REGISTRY = JSON.parse(
  readFileSync(join(HERE, "fixtures/semconv/media_parts.json"), "utf8"),
) as {
  stripped_reasons: Record<string, string>;
  part_shapes: { members: Record<string, string[]>; extensions: Record<string, string[]> };
  raw_payloads: {
    golden: Golden[];
    detection: Rule[];
    replacement: { format: string; unknown: string; mime_pattern: string };
  };
};
const RAW = REGISTRY.raw_payloads;
const asGolden = (t: MediaToken): GoldenToken => ({
  rule: t.rule,
  mime: t.mime ?? "unknown",
  byte_size: t.byteSize ?? "unknown",
});
const rule = (id: string) => RAW.detection.find((r) => r.id === id) as Rule;

describe("the raw-payload strip", () => {
  it("ports the registry's rules as the registry writes them", () => {
    expect(RAW.replacement.format).toBe(REPLACEMENT_FORMAT);
    expect(RAW.replacement.unknown).toBe(REPLACEMENT_UNKNOWN);
    expect(RAW.replacement.mime_pattern).toBe(MIME_PATTERN);
    expect(rule("b").pattern).toBe(DATA_URL_PATTERN);
    expect({
      type: rule("d").type,
      arrayKey: rule("d").array_key,
      mimeKeys: rule("d").mime_keys,
    }).toEqual(BUFFER_RULE);
    const e = rule("e");
    expect({
      keys: e.keys,
      siblingKeys: e.sibling_keys,
      parentKeys: e.parent_keys,
      sourceKey: e.source_key,
      sourceType: e.source_type,
      blobType: e.blob_type,
      blobKey: e.blob_key,
      typedKeys: (e.typed_keys as TypedKey[]).map((t) => ({
        key: t.key,
        types: t.types,
        ...(t.parent_keys ? { parentKeys: t.parent_keys } : {}),
        ...(t.keeps_urls ? { keepsUrls: t.keeps_urls } : {}),
        ...(t.holder_mime ? { holderMime: t.holder_mime } : {}),
      })),
      urlScheme: e.url_scheme,
      sourceBytesKeys: e.source_bytes_keys,
      base64Markers: e.base64_markers,
      mimeKeys: e.mime_keys,
      mimeFormats: (e.mime_formats as { key: string; mime: string; parent_keys?: string[] }[]).map(
        (f) => ({
          key: f.key,
          mime: f.mime,
          ...(f.parent_keys ? { parentKeys: f.parent_keys } : {}),
        }),
      ),
    }).toEqual(KEYED_RULE);
    expect(Object.keys(REGISTRY.stripped_reasons).sort()).toEqual([
      "not_captured",
      "redacted_upstream",
    ]);
  });

  it("builds parts with the registry's members, in its order", () => {
    const members = REGISTRY.part_shapes.members;
    expect(Object.keys(blobPart("image", "image/png", 8, "not_captured"))).toEqual(members.blob);
    expect(Object.keys(uriPart("image", "image/png", "https://x.test/a.png"))).toEqual(members.uri);
    expect(Object.keys(fileIdPart("image", "image/png", "f"))).toEqual(members.file);
  });

  it("names the registry's filename extensions, each with its modality", () => {
    const fromRegistry = Object.entries(REGISTRY.part_shapes.extensions).flatMap(
      ([modality, extensions]) => extensions.map((extension) => [extension, modality] as const),
    );
    expect(Object.entries(EXTENSION_MODALITY).sort()).toEqual(fromRegistry.sort());
  });

  it("has golden examples to run", () => {
    expect(RAW.golden.length).toBeGreaterThan(30);
  });

  for (const golden of RAW.golden) {
    it(`turns ${golden.name} into exactly its output`, () => {
      const result = strip(golden.input);
      expect(result.text).toBe(golden.output);
      expect(result.tokens.map(asGolden)).toEqual(golden.tokens);
    });

    it(`gives ${golden.name} its second-pass output, then nothing changes`, () => {
      const second = strip(golden.output);
      expect(second.text).toBe(golden.second_output ?? golden.output);
      expect(second.tokens.map(asGolden)).toEqual(golden.second_tokens ?? []);
      expect(stripRawPayload(second.text)).toBe(second.text);
    });
  }

  it("never fails on input nested past the depth limit", () => {
    const deep = `${"[".repeat(100_000)}"data:image/png;base64,QUFB"${"]".repeat(100_000)}`;
    expect(stripRawPayload(deep)).toBe(
      `${"[".repeat(100_000)}"[stripped image/png 3 bytes]"${"]".repeat(100_000)}`,
    );
    expect(MAX_DEPTH).toBe(64);
  });

  it("counts a nested document's depth from the arrays around its string", () => {
    // 63 arrays hold a string whose document is one object: 64 levels.
    const inner = '{\\"mediaType\\":\\"image/png\\",\\"data\\":\\"QUFB\\"}';
    const at64 = `${"[".repeat(63)}"${inner}"${"]".repeat(63)}`;
    expect(stripRawPayload(at64)).toContain("[stripped image/png 3 bytes]");
    const at65 = `${"[".repeat(64)}"${inner}"${"]".repeat(64)}`;
    expect(stripRawPayload(at65)).toBe(at65);
  });

  it("writes a mime holding $& literally", () => {
    expect(stripRawPayload('{"mediaType":"a$&b/c","data":"QUFB"}')).toBe(
      '{"mediaType":"a$&b/c","data":"[stripped a$&b/c 3 bytes]"}',
    );
  });

  it("keeps astral characters and their escapes around a token", () => {
    expect(stripRawPayload('{"t":"😀 \\ud83d\\ude00","u":"data:image/png;base64,QUFB 😀"}')).toBe(
      '{"t":"😀 \\ud83d\\ude00","u":"[stripped image/png 3 bytes] 😀"}',
    );
  });

  it("sizes base64 by the registry's rules, not a decoder's", () => {
    expect(base64Size("QUFB")).toBe(3);
    expect(base64Size("QQ==")).toBe(1);
    expect(base64Size("QQ")).toBeUndefined();
    expect(base64Size("Q===")).toBeUndefined();
    expect(base64Size("-_+/")).toBeUndefined();
    expect(base64Size(" Q U\nF\tB\r")).toBe(3);
  });

  it("recognizes a complete replacement only", () => {
    expect(isReplacement("[stripped image/png 8 bytes]")).toBe(true);
    expect(isReplacement("[stripped unknown unknown bytes]")).toBe(true);
    expect(isReplacement("[stripped image/png lots bytes]")).toBe(false);
    expect(isReplacement("[stripped a b 3 bytes]")).toBe(false);
  });

  // Each output is the registry's reference strip on the same input.
  it.each([
    [
      "keeps a link in an array under a Vercel image, and gives a data URL its own mime",
      '{"type":"image","image":["https://x.test/a.png","AAAA","data:image/gif;base64,AAAA"]}',
      '{"type":"image","image":["https://x.test/a.png","[stripped unknown 3 bytes]","[stripped image/gif 3 bytes]"]}',
      [
        { rule: "e", mime: "unknown", byte_size: 3 },
        { rule: "b", mime: "image/gif", byte_size: 3 },
      ],
    ],
    [
      "reads the holder's mime for tagged data through an array",
      '{"type":"file","mediaType":"image/png","data":[{"type":"data","data":"AAAA"}]}',
      '{"type":"file","mediaType":"image/png","data":[{"type":"data","data":"[stripped image/png 3 bytes]"}]}',
      [{ rule: "e", mime: "image/png", byte_size: 3 }],
    ],
    [
      "keeps a link in tagged data whose own sibling would make it keyed",
      '{"type":"file","mediaType":"image/png","data":{"type":"data","data":"https://x.test/a","mediaType":"image/png"}}',
      '{"type":"file","mediaType":"image/png","data":{"type":"data","data":"https://x.test/a","mediaType":"image/png"}}',
      [],
    ],
    [
      "reads tagged data's own mime before its holder's",
      '{"type":"file","mediaType":"image/png","data":{"type":"data","data":"AAAA","mime_type":"audio/wav"}}',
      '{"type":"file","mediaType":"image/png","data":{"type":"data","data":"[stripped audio/wav 3 bytes]","mime_type":"audio/wav"}}',
      [{ rule: "e", mime: "audio/wav", byte_size: 3 }],
    ],
    [
      "leaves tagged data under a parent key it does not name",
      '{"content":{"type":"data","data":"AAAA"}}',
      '{"content":{"type":"data","data":"AAAA"}}',
      [],
    ],
    [
      "counts a base64 marker only with exactly its value",
      '{"type":"image","source_type":"Base64","data":"AAAA"}',
      '{"type":"image","source_type":"Base64","data":"AAAA"}',
      [],
    ],
    [
      "makes a base64 marker context for every keyed member",
      '{"type":"image","source_type":"base64","result":"AAAA"}',
      '{"type":"image","source_type":"base64","result":"[stripped unknown 3 bytes]"}',
      [{ rule: "e", mime: "unknown", byte_size: 3 }],
    ],
    [
      "reads a scheme only when it starts with a letter",
      '{"type":"image","image":"1x:AAAA"}',
      '{"type":"image","image":"[stripped unknown unknown bytes]"}',
      [{ rule: "e", mime: "unknown", byte_size: "unknown" }],
    ],
    [
      "reads a scheme of letters, digits, plus, dot and dash",
      '{"type":"image","image":"a+b.c-d:rest"}',
      '{"type":"image","image":"a+b.c-d:rest"}',
      [],
    ],
  ])("%s", (_name, input, output, tokens) => {
    const result = strip(input);
    expect(result.text).toBe(output);
    expect(result.tokens.map(asGolden)).toEqual(tokens);
  });
});

describe("provider media items as parts", () => {
  const png = "iVBORw0KGgo=";

  it("maps an OpenAI chat data URL image to a blob and an https image to a uri", () => {
    expect(
      providerMediaParts({ type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }),
    ).toEqual([
      {
        type: "blob",
        modality: "image",
        mime_type: "image/png",
        byte_size: 8,
        stripped_reason: "not_captured",
      },
    ]);
    expect(
      providerMediaParts({ type: "image_url", image_url: { url: "https://x.test/a.png" } }),
    ).toEqual([{ type: "uri", modality: "image", uri: "https://x.test/a.png" }]);
  });

  it("maps OpenAI input_audio to an audio blob of mime audio/<format>", () => {
    expect(
      providerMediaParts({ type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } }),
    ).toEqual([
      {
        type: "blob",
        modality: "audio",
        mime_type: "audio/wav",
        byte_size: 4,
        stripped_reason: "not_captured",
      },
    ]);
  });

  it("maps an OpenAI chat file by id, and by data with its mime or filename", () => {
    expect(providerMediaParts({ type: "file", file: { file_id: "file-1" } })).toEqual([
      { type: "file", modality: "document", file_id: "file-1" },
    ]);
    expect(
      providerMediaParts({
        type: "file",
        file: { file_data: "data:application/pdf;base64,JVBERg==", filename: "a.pdf" },
      }),
    ).toEqual([
      {
        type: "blob",
        modality: "document",
        mime_type: "application/pdf",
        byte_size: 4,
        stripped_reason: "not_captured",
      },
    ]);
    expect(
      providerMediaParts({ type: "file", file: { file_data: png, filename: "a.PNG" } }),
    ).toEqual([{ type: "blob", modality: "image", byte_size: 8, stripped_reason: "not_captured" }]);
  });

  it("maps Responses input_image, input_file and image_generation_call", () => {
    expect(providerMediaParts({ type: "input_image", image_url: "https://x.test/a.png" })).toEqual([
      { type: "uri", modality: "image", uri: "https://x.test/a.png" },
    ]);
    expect(providerMediaParts({ type: "input_image", file_id: "file-2" })).toEqual([
      { type: "file", modality: "image", file_id: "file-2" },
    ]);
    expect(providerMediaParts({ type: "input_file", file_url: "https://x.test/a.pdf" })).toEqual([
      { type: "uri", modality: "document", uri: "https://x.test/a.pdf" },
    ]);
    expect(
      providerMediaParts({ type: "image_generation_call", output_format: "png", result: png }),
    ).toEqual([
      {
        type: "blob",
        modality: "image",
        mime_type: "image/png",
        byte_size: 8,
        stripped_reason: "not_captured",
      },
    ]);
  });

  it("maps Anthropic image and document sources", () => {
    expect(
      providerMediaParts({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "JVBERg==" },
      }),
    ).toEqual([
      {
        type: "blob",
        modality: "document",
        mime_type: "application/pdf",
        byte_size: 4,
        stripped_reason: "not_captured",
      },
    ]);
    expect(
      providerMediaParts({ type: "image", source: { type: "url", url: "https://x.test/a.png" } }),
    ).toEqual([{ type: "uri", modality: "image", uri: "https://x.test/a.png" }]);
    expect(
      providerMediaParts({ type: "document", source: { type: "file", file_id: "file_3" } }),
    ).toEqual([{ type: "file", modality: "document", file_id: "file_3" }]);
    expect(
      providerMediaParts({
        type: "document",
        source: { type: "text", media_type: "text/plain", data: "plain words" },
      }),
    ).toEqual([{ type: "text", content: "plain words" }]);
    expect(
      providerMediaParts({
        type: "document",
        source: {
          type: "content",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      }),
    ).toEqual([
      { type: "text", content: "a" },
      { type: "text", content: "b" },
    ]);
  });

  const blob = (modality: string, mime: string | undefined, size: number) => ({
    type: "blob",
    modality,
    ...(mime === undefined ? {} : { mime_type: mime }),
    byte_size: size,
    stripped_reason: "not_captured",
  });

  it("maps a Mistral input_audio string to an audio blob with no mime", () => {
    expect(providerMediaParts({ type: "input_audio", input_audio: "UklGRiQAAABXQVZF" })).toEqual([
      blob("audio", undefined, 12),
    ]);
    expect(
      providerMediaParts({ type: "input_audio", input_audio: "data:audio/wav;base64,UklGRg==" }),
    ).toEqual([blob("audio", "audio/wav", 4)]);
  });

  it("maps Mistral's TypeScript inputAudio string to an audio blob with no mime", () => {
    expect(providerMediaParts({ type: "input_audio", inputAudio: "UklGRiQAAABXQVZF" })).toEqual([
      blob("audio", undefined, 12),
    ]);
  });

  it.each([
    [{ type: "image", base64: png, mime_type: "image/png" }, blob("image", "image/png", 8)],
    [{ type: "audio", base64: "UklGRg==" }, blob("audio", undefined, 4)],
    [{ type: "video", base64: "AAAA", mime_type: "video/mp4" }, blob("video", "video/mp4", 3)],
    [
      { type: "file", base64: "JVBERi0=", mime_type: "application/pdf" },
      blob("document", "application/pdf", 5),
    ],
    [{ type: "file", base64: "JVBERi0=" }, blob("document", undefined, 5)],
    [{ type: "file", base64: png, mime_type: "image/png" }, blob("image", "image/png", 8)],
    [
      { type: "text-plain", base64: "aGVsbG8=", mime_type: "text/plain" },
      blob("document", "text/plain", 5),
    ],
  ])("maps the LangChain v1 base64 block %j to a blob", (block, part) => {
    expect(providerMediaParts(block)).toEqual([part]);
  });

  const dropped = (modality: string, mime?: string) => ({
    type: "blob",
    modality,
    ...(mime === undefined ? {} : { mime_type: mime }),
    stripped_reason: "redacted_upstream",
  });

  it.each([
    [
      { type: "image", url: "https://x.test/a.bin", mime_type: "image/png" },
      { type: "uri", modality: "image", mime_type: "image/png", uri: "https://x.test/a.bin" },
    ],
    [
      { type: "video", url: "gs://bucket/clip.png" },
      { type: "uri", modality: "video", uri: "gs://bucket/clip.png" },
    ],
    [
      { type: "file", url: "https://x.test/a.mp4?x=1" },
      { type: "uri", modality: "video", uri: "https://x.test/a.mp4?x=1" },
    ],
    [
      { type: "file", url: "https://x.test/a.png", mime_type: "application/pdf" },
      {
        type: "uri",
        modality: "document",
        mime_type: "application/pdf",
        uri: "https://x.test/a.png",
      },
    ],
    [{ type: "file", url: "data:;base64,UklGRg==" }, blob("document", undefined, 4)],
    [
      { type: "image", url: "data:image/jpeg;base64,AAAA", mime_type: "image/png" },
      blob("image", "image/jpeg", 3),
    ],
    [
      { type: "audio", file_id: "file-1" },
      { type: "file", modality: "audio", file_id: "file-1" },
    ],
    [{ type: "image", url: "", file_id: "__REDACTED__" }, dropped("image")],
    [{ type: "file", url: "__REDACTED__", mime_type: "audio/wav" }, dropped("audio", "audio/wav")],
    [{ type: "video", url: 5, file_id: "" }, dropped("video")],
  ])("maps the LangChain v1 reference block %j", (block, part) => {
    expect(providerMediaParts(block)).toEqual([part]);
  });

  it.each([
    [
      "base64 over a url and a file_id",
      { type: "image", url: "https://x.test/a.png", file_id: "f", base64: png },
      blob("image", undefined, 8),
    ],
    [
      "a usable file_id over a url",
      { type: "image", url: "https://x.test/a.png", file_id: "f" },
      { type: "file", modality: "image", file_id: "f" },
    ],
    [
      "a usable url over a dropped file_id",
      { type: "audio", url: "https://x.test/a", file_id: "" },
      { type: "uri", modality: "audio", uri: "https://x.test/a" },
    ],
    [
      "a file block's usable file_id over its base64 and url",
      { type: "file", file_id: "f", base64: png, url: "https://x.test/a.png" },
      { type: "file", modality: "document", file_id: "f" },
    ],
    [
      "a usable url over a file block's redacted file_id",
      { type: "file", file_id: "__REDACTED__", url: "https://x.test/a.png" },
      { type: "uri", modality: "image", uri: "https://x.test/a.png" },
    ],
    [
      "base64 over a file block's empty file_id",
      { type: "file", file_id: "", base64: "JVBERi0=" },
      blob("document", undefined, 5),
    ],
    [
      "a file block's string file_id over a dropped url, kept as written",
      { type: "file", file_id: "", url: "__REDACTED__" },
      { type: "file", modality: "document", file_id: "" },
    ],
    [
      "a url over a file block's file_id that is not a string",
      { type: "file", file_id: 5, url: "https://x.test/a.wav" },
      { type: "uri", modality: "audio", uri: "https://x.test/a.wav" },
    ],
    [
      "a usable file_id over an OpenAI-style file member",
      { type: "file", file: { file_data: png, filename: "a.png" }, file_id: "f" },
      { type: "file", modality: "document", file_id: "f" },
    ],
  ])("reads a LangChain v1 block in its order: %s", (_name, block, part) => {
    expect(providerMediaParts(block)).toEqual([part]);
  });

  it.each([
    [
      "kept by a file block by a usable file_id",
      { type: "file", file_id: "f", modality: "audio", mime_type: "image/png" },
      { type: "file", modality: "audio", mime_type: "image/png", file_id: "f" },
    ],
    [
      "kept by a file block with a dropped file_id and nothing usable",
      { type: "file", file_id: "", url: "", modality: "video" },
      { type: "file", modality: "video", file_id: "" },
    ],
    [
      "ignored by a block by url",
      { type: "image", url: "https://x.test/a", modality: "audio" },
      { type: "uri", modality: "image", uri: "https://x.test/a" },
    ],
    [
      "ignored by a block by file_id",
      { type: "audio", file_id: "f", modality: "image" },
      { type: "file", modality: "audio", file_id: "f" },
    ],
  ])("has a LangChain v1 block's modality member %s", (_name, block, part) => {
    expect(providerMediaParts(block)).toEqual([part]);
  });

  it("reads a LangChain v0 url block as a v1 one, and leaves its base64 and id blocks", () => {
    expect(
      providerMediaParts({ type: "image", source_type: "url", url: "https://x.test/a.png" }),
    ).toEqual([{ type: "uri", modality: "image", uri: "https://x.test/a.png" }]);
    expect(providerMediaParts({ type: "image", source_type: "base64", data: png })).toBeUndefined();
    expect(providerMediaParts({ type: "file", source_type: "id", id: "file-1" })).toBeUndefined();
  });

  it.each([
    { type: "text-plain", url: "https://x.test/a.txt" },
    { type: "text-plain", file_id: "file-1" },
    { type: "image", url: 5 },
    { type: "audio", file_id: null },
  ])("leaves the LangChain v1 block %j as it came", (block) => {
    expect(providerMediaParts(block)).toBeUndefined();
  });

  it("leaves a base64 member on a block type that names no media", () => {
    expect(providerMediaParts({ type: "custom", base64: png })).toBeUndefined();
  });

  it.each([
    [{ image: { format: "png", source: { bytes: png } } }, blob("image", "image/png", 8)],
    [{ video: { format: "mp4", source: { bytes: "AAAA" } } }, blob("video", undefined, 3)],
    [
      { document: { format: "pdf", name: "report", source: { bytes: "JVBERi0=" } } },
      blob("document", undefined, 5),
    ],
    [{ audio: { format: "mp3", source: { bytes: "UklGRg==" } } }, blob("audio", undefined, 4)],
    [{ image: { source: { bytes: png } } }, blob("image", undefined, 8)],
    [
      { image: { format: "jpeg", source: { bytes: new Uint8Array([255, 216, 255, 224]) } } },
      blob("image", "image/jpeg", 4),
    ],
    [
      { audio: { format: "wav", source: { bytes: new Uint8Array([82, 73, 70, 70]) } } },
      blob("audio", undefined, 4),
    ],
  ])("maps the Bedrock Converse block %j to a blob", (block, part) => {
    expect(providerMediaParts(block)).toEqual([part]);
  });

  it("leaves a typed block with a Bedrock key as it came", () => {
    expect(
      providerMediaParts({ type: "custom", image: { format: "png", source: { bytes: png } } }),
    ).toBeUndefined();
  });

  it.each([
    ["no reference", { type: "input_image" }],
    ["a file_id that is not a string", { type: "input_image", file_id: 5 }],
    ["a null image_url", { type: "input_image", image_url: null }],
  ])("leaves an input_image with %s as it came", (_name, block) => {
    expect(providerMediaParts(block)).toBeUndefined();
  });

  it("leaves a Bedrock Converse source by S3 location as it came", () => {
    expect(
      providerMediaParts({ image: { format: "png", source: { s3Location: { uri: "s3://b/a" } } } }),
    ).toBeUndefined();
  });

  it("maps Gemini inline_data and file_data", () => {
    expect(providerMediaParts({ inline_data: { mime_type: "image/png", data: png } })).toEqual([
      {
        type: "blob",
        modality: "image",
        mime_type: "image/png",
        byte_size: 8,
        stripped_reason: "not_captured",
      },
    ]);
    expect(
      providerMediaParts({ file_data: { mime_type: "video/mp4", file_uri: "gs://b/a.mp4" } }),
    ).toEqual([{ type: "uri", modality: "video", mime_type: "video/mp4", uri: "gs://b/a.mp4" }]);
  });

  it("strips a native blob, mime first, and fills a missing modality from the mime", () => {
    expect(
      providerMediaParts({
        type: "blob",
        modality: "image",
        mime_type: "application/pdf",
        content: "JVBERg==",
      }),
    ).toEqual([
      {
        type: "blob",
        modality: "document",
        mime_type: "application/pdf",
        byte_size: 4,
        stripped_reason: "not_captured",
      },
    ]);
    expect(
      providerMediaParts({ type: "uri", mime_type: "image/png", uri: "https://x.test/a.png" }),
    ).toEqual([
      { type: "uri", modality: "image", mime_type: "image/png", uri: "https://x.test/a.png" },
    ]);
    expect(
      providerMediaParts({ type: "file", mime_type: "application/pdf", file_id: "f", extra: 1 }),
    ).toEqual([{ type: "file", modality: "document", mime_type: "application/pdf", file_id: "f" }]);
  });

  it("always rebuilds a native part into the normalized shape", () => {
    expect(providerMediaParts({ type: "blob", content: "QUJD", extra: true })).toEqual([
      { type: "blob", modality: "document", byte_size: 3, stripped_reason: "not_captured" },
    ]);
    expect(providerMediaParts({ type: "uri", uri: "https://x" })).toEqual([
      { type: "uri", modality: "document", uri: "https://x" },
    ]);
    expect(
      providerMediaParts({
        type: "uri",
        uri: "https://x",
        modality: "image",
        mime_type: "application/pdf",
      }),
    ).toEqual([{ type: "uri", modality: "image", mime_type: "application/pdf", uri: "https://x" }]);
    expect(
      providerMediaParts({
        type: "uri",
        modality: "audio",
        mime_type: "text/plain;charset=x",
        uri: "https://x",
      }),
    ).toEqual([{ type: "uri", modality: "audio", uri: "https://x" }]);
    expect(
      providerMediaParts({ type: "file", modality: "audio", file_id: "f", name: "a.wav" }),
    ).toEqual([{ type: "file", modality: "audio", file_id: "f" }]);
    expect(
      providerMediaParts({
        type: "blob",
        modality: "image",
        mime_type: null,
        stripped_reason: "redacted_upstream",
      }),
    ).toEqual([{ type: "blob", modality: "image", stripped_reason: "redacted_upstream" }]);
  });

  it("writes a rebuilt part's members in the pinned order", () => {
    expect(
      JSON.stringify(
        providerMediaParts({
          uri: "https://x",
          mime_type: "application/pdf",
          modality: "image",
          type: "uri",
        }),
      ),
    ).toBe('[{"type":"uri","modality":"image","mime_type":"application/pdf","uri":"https://x"}]');
    expect(
      JSON.stringify(
        providerMediaParts({
          content: "QUJD",
          extra: 1,
          mime_type: "image/png",
          modality: "document",
          type: "blob",
        }),
      ),
    ).toBe(
      '[{"type":"blob","modality":"image","mime_type":"image/png","byte_size":3,"stripped_reason":"not_captured"}]',
    );
  });

  it("takes a uri's modality from its extension when nothing else names it", () => {
    expect(providerMediaParts({ type: "uri", uri: "https://example.com/clip.mov?x=1#t" })).toEqual([
      { type: "uri", modality: "video", uri: "https://example.com/clip.mov?x=1#t" },
    ]);
    expect(providerMediaParts({ file_data: { file_uri: "gs://b/a.MP3" } })).toEqual([
      { type: "uri", modality: "audio", uri: "gs://b/a.MP3" },
    ]);
    expect(providerMediaParts({ type: "file", file_id: "file-abc123" })).toEqual([
      { type: "file", modality: "document", file_id: "file-abc123" },
    ]);
  });

  it("makes a blob of a uri holding a data URL, native or Gemini's file_data", () => {
    expect(providerMediaParts({ type: "uri", uri: "data:image/png;base64,QUFB" })).toEqual([
      {
        type: "blob",
        modality: "image",
        mime_type: "image/png",
        byte_size: 3,
        stripped_reason: "not_captured",
      },
    ]);
    expect(
      providerMediaParts({ type: "uri", modality: "document", uri: "data:text/plain,hi" }),
    ).toEqual([
      {
        type: "blob",
        modality: "document",
        mime_type: "text/plain",
        stripped_reason: "not_captured",
      },
    ]);
    expect(providerMediaParts({ file_data: { file_uri: "data:None;url,None" } })).toEqual([
      { type: "blob", modality: "document", stripped_reason: "redacted_upstream" },
    ]);
  });

  it("leaves a part it does not know alone", () => {
    expect(providerMediaParts({ type: "refusal", refusal: "no" })).toBeUndefined();
    expect(providerMediaParts({ text: "gemini text" })).toBeUndefined();
  });
});
