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
      typedKeys: (e.typed_keys as { key: string; types: string[] }[]).map((t) => ({
        key: t.key,
        types: t.types,
      })),
      sourceBytesKeys: e.source_bytes_keys,
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
