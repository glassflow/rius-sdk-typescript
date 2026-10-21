// The media contract's part and message examples, made by this SDK byte for
// byte, and the rules they pin: a URL of any scheme but data: keeps its link, a
// URL or file id dropped upstream is a blob redacted upstream, and no part this
// SDK writes is malformed.

import type { Attributes, AttributeValue } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { nativeMediaPart, providerMediaParts, rebuildNativeMediaParts } from "../src/mediaParts.js";
import { serializeMessages } from "../src/messages.js";
import { NormalizingSpanProcessor } from "../src/normalize.js";
import { CONTRACT, canonicalErrors, type PartExample } from "./mediaContract.js";

/** The parts one provider item becomes, each of them canonical. */
function parts(item: unknown): unknown[] | undefined {
  const made = providerMediaParts(item);
  for (const part of made ?? []) {
    expect(canonicalErrors(part as Record<string, unknown>), JSON.stringify(part)).toEqual([]);
  }
  return made;
}

/** gen_ai.input.messages for one user message of AI SDK parts, as a model call writes it. */
function vercelMessages(content: unknown[]): string {
  return inputMessages({
    "ai.operationId": "ai.generateText.doGenerate",
    "ai.prompt.messages": JSON.stringify([{ role: "user", content }]),
  });
}

/** gen_ai.input.messages a span with these attributes is normalized into. */
function inputMessages(attributes: Attributes): string {
  new NormalizingSpanProcessor().onEnd({
    attributes,
    events: [],
    links: [],
    status: { code: 0 },
    startTime: [1700000000, 0],
    endTime: [1700000001, 0],
  } as unknown as ReadableSpan);
  return attributes["gen_ai.input.messages"] as string;
}

/** The one part one AI SDK file or image part becomes. */
function vercelPart(part: Record<string, AttributeValue | object>): string {
  const [message] = JSON.parse(vercelMessages([part]));
  expect(message.parts).toHaveLength(1);
  return JSON.stringify(message.parts[0]);
}

/**
 * The one part an OpenInference image content entry becomes, its flattened
 * keys written relative to the content prefix, as the contract writes them.
 */
function openInferencePart(entry: Record<string, string>): string {
  const attributes: Attributes = { "llm.input_messages.0.message.role": "user" };
  for (const [key, value] of Object.entries(entry)) {
    attributes[`llm.input_messages.0.message.contents.0.${key}`] = value;
  }
  const [message] = JSON.parse(inputMessages(attributes));
  expect(message.parts).toHaveLength(1);
  return JSON.stringify(message.parts[0]);
}

type Made = { item: unknown } | { vercel: Record<string, AttributeValue | object> };

/**
 * The part a contract `provider` item makes, through the reader that takes
 * it: OpenInference's flattened image entry, an AI SDK file or image part
 * (no Anthropic source), or any other provider item.
 */
function providerPart(item: Record<string, unknown>): string {
  if (Object.hasOwn(item, "message_content.type")) {
    return openInferencePart(item as Record<string, string>);
  }
  if ((item.type === "file" || item.type === "image") && item.source === undefined) {
    return vercelPart(item as Record<string, AttributeValue | object>);
  }
  const [part] = parts(item) ?? [];
  return JSON.stringify(part);
}

/** Each part example of the contract, made from an input its `from` describes. */
const EXAMPLE_INPUTS: Record<string, Made> = {
  blob_with_a_known_size: {
    item: { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
  },
  blob_whose_bytes_never_arrived: { item: { type: "image_url", image_url: "__REDACTED__" } },
  data_url_that_is_not_base64: { item: { type: "uri", uri: "data:text/plain,hello" } },
  data_url_that_is_not_base64_and_empty: { item: { type: "uri", uri: "data:image/png," } },
  blob_with_content_and_no_hint: { item: { type: "blob", content: "iVBORw0KGgo=" } },
  blob_with_content_labelled_image_for_a_pdf: {
    item: { type: "blob", content: "JVBERi0=", mime_type: "application/pdf", modality: "image" },
  },
  blob_with_content_that_is_an_empty_base64_data_url: {
    item: { type: "blob", mime_type: "image/png", content: "data:;base64," },
  },
  blob_with_no_content_and_no_stripped_reason: { item: { type: "blob", modality: "audio" } },
  blob_with_content_that_is_not_a_string: { item: { type: "blob", content: 5, byte_size: 8.0 } },
  uri_with_no_mime_type_and_no_modality: {
    item: { type: "uri", uri: "https://example.com/download" },
  },
  uri_with_members_out_of_order_keeps_its_modality: {
    item: { uri: "https://example.com/talk", modality: "image", type: "uri", note: "x" },
  },
  uri_with_an_invalid_mime_type: {
    item: { type: "uri", mime_type: "text/plain;charset=x", uri: "https://example.com/notes" },
  },
  uri_that_is_a_data_url: { item: { type: "uri", uri: "data:image/png;base64,iVBORw0KGgo=" } },
  uri_with_a_mime_type: {
    item: { type: "uri", mime_type: "audio/mpeg", uri: "https://example.com/a.mp3" },
  },
  uri_with_only_an_extension: { item: { type: "uri", uri: "https://example.com/clip.mov" } },
  file_with_no_hint: { item: { type: "file", file_id: "file-abc123" } },
  uri_with_a_cloud_storage_scheme: {
    vercel: { type: "file", mediaType: "image/png", data: "gs://bucket/a.png" },
  },
  uri_tagged_url_with_an_s3_scheme: {
    vercel: { type: "file", data: { type: "url", url: "s3://bucket/report.pdf" } },
  },
  uri_with_the_file_scheme_and_only_an_extension: {
    vercel: { type: "file", data: "file:///tmp/clip.mov" },
  },
  vercel_file_by_url_with_no_media_type: {
    vercel: { type: "file", data: "https://example.com/a.png" },
  },
  blob_from_an_unknown_v7_data_tag: {
    vercel: { type: "file", mediaType: "image/png", data: { type: "reference", id: "x" } },
  },
  image_url_that_is_empty: { item: { type: "image_url", image_url: { url: "" } } },
  image_url_that_is_redacted: { item: { type: "image_url", image_url: { url: "__REDACTED__" } } },
  anthropic_url_source_that_is_empty: {
    item: { type: "document", source: { type: "url", url: "" } },
  },
  anthropic_file_source_that_is_empty: {
    item: { type: "image", source: { type: "file", file_id: "", media_type: "image/png" } },
  },
  input_image_with_an_empty_file_id: { item: { type: "input_image", file_id: "" } },
  openai_file_with_an_empty_file_id: {
    item: { type: "file", file: { file_id: "", filename: "a.png" } },
  },
  input_image_with_a_redacted_url_and_a_file_id: {
    item: { type: "input_image", image_url: "__REDACTED__", file_id: "file-abc123" },
  },
  openai_file_with_no_reference: { item: { type: "file", file: { filename: "a.png" } } },
  openai_file_with_a_file_id_that_is_not_a_string: {
    item: { type: "file", file: { file_id: 5, filename: "a.wav" } },
  },
  input_file_with_no_reference_and_no_filename: { item: { type: "input_file" } },
  uri_led_by_whitespace_holding_a_data_url: {
    item: { type: "uri", modality: "image", uri: " data:image/png;base64,iVBO\nRw0KGgo=" },
  },
};

describe("the contract's part examples", () => {
  const examples = CONTRACT.part_shapes.examples;

  it("are every one made here, from the contract's block or provider or an input built here", () => {
    const fromContract = (e: PartExample) => e.block !== undefined || e.provider !== undefined;
    const unbuilt = examples.filter(
      (e) => !fromContract(e) && !Object.hasOwn(EXAMPLE_INPUTS, e.name),
    );
    expect(unbuilt.map((e) => e.name)).toEqual([]);
    const built = examples.filter((e) => e.block === undefined).map((e) => e.name);
    expect(Object.keys(EXAMPLE_INPUTS).filter((name) => !built.includes(name))).toEqual([]);
  });

  it.each(examples.map((e) => [e.name, e] as const))("%s, byte for byte", (name, example) => {
    if (example.provider !== undefined) {
      expect(providerPart(JSON.parse(example.provider))).toBe(example.part);
    }
    const made: Made | undefined =
      example.block === undefined ? EXAMPLE_INPUTS[name] : { item: JSON.parse(example.block) };
    if (made === undefined) return;
    if ("vercel" in made) {
      expect(vercelPart(made.vercel)).toBe(example.part);
      return;
    }
    const [part] = parts([made.item][0]) ?? [];
    expect(JSON.stringify(part)).toBe(example.part);
  });
});

describe("the contract's native part examples", () => {
  const examples = CONTRACT.part_shapes.examples.filter((e) => e.native !== undefined);

  it("are there to check", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it.each(examples.map((e) => [e.name, e] as const))("%s, byte for byte", (_name, example) => {
    const native = example.native as string;
    const [part] = nativeMediaPart(JSON.parse(native)) ?? [];
    expect(JSON.stringify(part)).toBe(example.part);
    // The same part rebuilt in a message key, every other byte kept.
    const messages = (part: string) => `[{"role":"user","parts":[${part}]}]`;
    expect(rebuildNativeMediaParts(messages(native), true)).toBe(messages(example.part));
  });
});

describe("the contract's in-place examples", () => {
  it.each(CONTRACT.part_shapes.in_place_examples.map((e) => [e.name, e] as const))(
    "%s, byte for byte",
    (_name, example) => {
      expect(rebuildNativeMediaParts(example.input, true)).toBe(example.output);
    },
  );
});

const blob = (members: Record<string, unknown> = {}) => ({
  type: "blob",
  modality: "image",
  ...members,
  stripped_reason: "not_captured",
});

describe("a canonical part", () => {
  it.each([
    [blob({ byte_size: -1 }), "byte_size -1"],
    [blob({ byte_size: "8" }), 'byte_size "8"'],
    [blob({ byte_size: 2.5 }), "byte_size 2.5"],
    [blob({ byte_size: 2 ** 53 }), "byte_size 9007199254740992"],
    [{ type: "uri", modality: "image", uri: { href: "h" } }, 'uri {"href":"h"}'],
    [{ type: "file", modality: "image", file_id: 5 }, "file_id 5"],
    [{ type: "file", modality: "picture", file_id: "f" }, 'modality "picture"'],
    [{ type: "blob", modality: "image", stripped_reason: "gone" }, 'stripped_reason "gone"'],
    [{ type: "uri", modality: "image", mime_type: "image", uri: "u" }, 'mime_type "image"'],
    [{ type: "uri", modality: "image", mime_type: 5, uri: "u" }, "mime_type 5"],
  ])("rejects a wrong value: %j", (part, error) => {
    const errors = canonicalErrors(part);
    expect(
      errors.some((e) => e.startsWith(error)),
      JSON.stringify(errors),
    ).toBe(true);
  });

  it.each([
    blob({ mime_type: "image/png", byte_size: 0 }),
    blob({ byte_size: 2 ** 53 - 1 }),
    { type: "uri", modality: "video", uri: "" },
    { type: "file", modality: "document", file_id: "" },
  ])("accepts the values the contract allows: %j", (part) => {
    expect(canonicalErrors(part)).toEqual([]);
  });
});

/**
 * Message-example sources this SDK makes no messages from: the gen_ai.prompt.N
 * content OpenLLMetry and Laminar flatten is the sink's to read. Their blocks
 * still pass through this SDK as a message's content, and must make the same
 * parts there.
 */
const OTHER_SOURCES = ["gen_ai.prompt.0.content"];

describe("the contract's message examples", () => {
  const all = CONTRACT.part_shapes.message_examples ?? [];
  const examples = all.filter((e) => !OTHER_SOURCES.includes(e.source));

  it("are there", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it("come from ai.prompt.messages, or from a source skipped by name", () => {
    const sources = all.map((e) => e.source);
    expect(sources.filter((s) => s !== "ai.prompt.messages")).toEqual(
      sources.filter((s) => OTHER_SOURCES.includes(s)),
    );
  });

  it.each(all.filter((e) => OTHER_SOURCES.includes(e.source)).map((e) => [e.name, e] as const))(
    "%s's blocks, passed through as a message's content, byte for byte",
    (_name, example) => {
      const role = example.attributes?.["gen_ai.prompt.0.role"];
      const message = { role, content: JSON.parse(example.input) };
      expect(serializeMessages([message], "user")).toBe(example.output);
    },
  );

  it.each(examples.map((e) => [e.name, e] as const))("%s, byte for byte", (_name, example) => {
    expect(example.source).toBe("ai.prompt.messages");
    const [message] = JSON.parse(example.input);
    expect(vercelMessages(message.content)).toBe(example.output);
  });
});

const redacted = (modality: string, mime?: string) => ({
  type: "blob",
  modality,
  ...(mime ? { mime_type: mime } : {}),
  stripped_reason: "redacted_upstream",
});

describe("a URL or file id dropped upstream", () => {
  it.each([
    [{ type: "image_url", image_url: { url: "" } }, redacted("image")],
    [{ type: "image_url", image_url: "" }, redacted("image")],
    [{ type: "image_url", image_url: { url: "__REDACTED__" } }, redacted("image")],
    [{ type: "input_image", image_url: "" }, redacted("image")],
    [{ type: "input_image", file_id: "" }, redacted("image")],
    [{ type: "input_image", image_url: "", file_id: "__REDACTED__" }, redacted("image")],
    [{ type: "image", source: { type: "url", url: "" } }, redacted("image")],
    [
      {
        type: "document",
        source: { type: "url", url: "__REDACTED__", media_type: "application/pdf" },
      },
      redacted("document", "application/pdf"),
    ],
    [{ type: "image", source: { type: "file", file_id: "" } }, redacted("image")],
    [{ type: "document", source: { type: "file", file_id: "__REDACTED__" } }, redacted("document")],
    [{ file_data: { mime_type: "image/png", file_uri: "" } }, redacted("image", "image/png")],
    [{ fileData: { fileUri: "__REDACTED__" } }, redacted("document")],
    [{ type: "file", file: { file_url: "__REDACTED__", filename: "a.png" } }, redacted("image")],
    [{ type: "input_file", file_id: "__REDACTED__" }, redacted("document")],
  ])("%j is a blob redacted upstream", (item, part) => {
    expect(parts(item)).toEqual([part]);
  });

  it.each([
    [
      { type: "input_image", image_url: "__REDACTED__", file_id: "file-1" },
      { type: "file", modality: "image", file_id: "file-1" },
    ],
    [
      { type: "input_image", image_url: "", file_id: "file-1" },
      { type: "file", modality: "image", file_id: "file-1" },
    ],
    [
      {
        type: "file",
        file: { file_id: "__REDACTED__", file_data: "iVBORw0KGgo=", filename: "a.png" },
      },
      { type: "blob", modality: "image", byte_size: 8, stripped_reason: "not_captured" },
    ],
    [
      { type: "input_file", file_id: "__REDACTED__", file_url: "https://x/a.pdf" },
      { type: "uri", modality: "document", uri: "https://x/a.pdf" },
    ],
  ])("loses to a usable reference: %j", (item, part) => {
    expect(parts(item)).toEqual([part]);
  });

  it.each([
    { file_id: "" },
    { file_url: "" },
    { file_data: "" },
    { file_id: "", file_url: "", filename: "a.wav" },
    { file_data: "", file_id: "__REDACTED__", filename: "a.wav" },
    { file_data: "__REDACTED__", filename: "a.wav" },
  ])("in an OpenAI file %j, with nothing usable, is a redacted blob, never a bare file", (file) => {
    const part = redacted("filename" in file ? "audio" : "document");
    expect(parts({ type: "file", file })).toEqual([part]);
    expect(parts({ type: "input_file", ...file })).toEqual([part]);
  });

  it.each([
    { filename: "a.wav" },
    { file_id: 5, filename: "a.wav" },
    { file_id: null, filename: "a.wav" },
    { file_data: ["x"], file_url: { u: 1 }, filename: "a.wav" },
    { file_id: 5, file_url: "__REDACTED__", filename: "a.wav" },
    {},
  ])("in an OpenAI file %j, with no string reference, is a redacted blob", (file) => {
    const part = redacted("filename" in file ? "audio" : "document");
    expect(parts({ type: "file", file })).toEqual([part]);
    expect(parts({ type: "input_file", ...file })).toEqual([part]);
  });

  it("is kept in a native uri or file part, which is no provider item", () => {
    expect(parts({ type: "uri", uri: "" })).toEqual([
      { type: "uri", modality: "document", uri: "" },
    ]);
    expect(parts({ type: "file", file_id: "" })).toEqual([
      { type: "file", modality: "document", file_id: "" },
    ]);
  });
});

describe("a URL of any scheme but data:", () => {
  it.each([
    [
      { type: "image_url", image_url: { url: "gs://bucket/a.png" } },
      { type: "uri", modality: "image", uri: "gs://bucket/a.png" },
    ],
    [
      { type: "input_image", image_url: "s3://bucket/a.jpg" },
      { type: "uri", modality: "image", uri: "s3://bucket/a.jpg" },
    ],
    [
      { type: "document", source: { type: "url", url: "file:///tmp/a.pdf" } },
      { type: "uri", modality: "document", uri: "file:///tmp/a.pdf" },
    ],
    [
      { file_data: { file_uri: "s3://bucket/clip.webm" } },
      { type: "uri", modality: "video", uri: "s3://bucket/clip.webm" },
    ],
    [
      { type: "uri", uri: "gs://bucket/a.wav" },
      { type: "uri", modality: "audio", uri: "gs://bucket/a.wav" },
    ],
  ])("keeps its link: %j", (item, part) => {
    expect(parts(item)).toEqual([part]);
  });
});
