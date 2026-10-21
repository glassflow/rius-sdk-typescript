import type { AttributeValue } from "@opentelemetry/api";
import { replacement, stripRawPayload } from "./mediaParts.js";

/**
 * Serialized payload cap, in characters, shared with the Python SDK so a
 * payload lands the same size whichever SDK produced it. Applies to every
 * string this module produces: JSON-encoded objects and bare strings alike.
 * Without it a 5 MB tool result was a 5 MB span (2026-09 review).
 */
export const MAX_ATTR_CHARS = 32 * 1024;

/** Appended to a cut payload; the same marker the Python SDK writes. */
export const TRUNCATION_MARKER = "…(truncated)";

/**
 * `text` stripped of inline media, then cut at the attribute cap, marking the
 * cut. Stripped first: base64 kept verbatim would fill the cap with bytes
 * nobody can read, and a cut payload no longer parses, so its keyed media
 * could not be found any more.
 */
export function truncate(text: string): string {
  const stripped = stripRawPayload(text);
  return stripped.length > MAX_ATTR_CHARS
    ? stripped.slice(0, MAX_ATTR_CHARS) + TRUNCATION_MARKER
    : stripped;
}

/**
 * Values JSON.stringify cannot render as data, made renderable. Called from
 * the replacer with the HOLDER's original property, not the value the
 * replacer receives: JSON.stringify runs `toJSON` first, so a Buffer would
 * already have become `{type: "Buffer", data: [...]}` by then.
 */
function renderable(raw: unknown, value: unknown): unknown {
  if (typeof raw === "bigint") return String(raw);
  if (raw instanceof Map) {
    // A byte key would otherwise be written as its decimal bytes.
    return Object.fromEntries(
      [...raw].map(([k, v]) => [isByteObject(k) ? byteObjectMarker(k) : k, v]),
    );
  }
  if (raw instanceof Set) return [...raw];
  if (isByteObject(raw)) {
    // Bytes are not content a trace can show; a size is, and a byte array
    // exploded into JSON was many times the payload's own size. The marker
    // is the strip's replacement with the unknown mime, the same text the
    // Python SDK writes for bytes, so it is never stripped again.
    return byteObjectMarker(raw);
  }
  return value;
}

/** A byte object's marker: the strip's replacement, unknown mime, its size in bytes. */
function byteObjectMarker(bytes: { byteLength: number }): string {
  return replacement(undefined, bytes.byteLength);
}

/** The built-in tags of the byte objects that are not views. */
const BUFFER_TAGS: readonly string[] = ["[object ArrayBuffer]", "[object SharedArrayBuffer]"];

/**
 * An ArrayBuffer, a SharedArrayBuffer or any view on one (each typed array,
 * a Node Buffer, a DataView). Its byteLength is its size in bytes, a view's
 * own length rather than its buffer's. Never `instanceof`: a buffer made in
 * another realm (a vm context, a worker's transfer) has another realm's
 * constructor, so isView and the built-in tag are what recognize it.
 */
function isByteObject(raw: unknown): raw is { byteLength: number } {
  return (
    ArrayBuffer.isView(raw) ||
    (typeof raw === "object" &&
      raw !== null &&
      BUFFER_TAGS.includes(Object.prototype.toString.call(raw)) &&
      typeof (raw as { byteLength?: unknown }).byteLength === "number")
  );
}

/**
 * The value as a plain record, or undefined when it is not an object. The one
 * narrowing for loosely typed payloads that are read field by field (MCP
 * results, transports), so each reader is an optional chain, not a guard.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Coerce an arbitrary value into something an OTel attribute accepts, bounded
 * by {@link MAX_ATTR_CHARS}. Must never throw: this runs on the user's data on
 * the hot path.
 */
export function toAttributeValue(value: unknown): string | number | boolean {
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "bigint") return String(value);
  // Track the ANCESTOR chain, not every object seen. A global seen-set would
  // report a shared sibling reference ({ a: x, b: x }) as circular and drop
  // real data, which is a plausible shape in LLM message payloads.
  const ancestors: unknown[] = [];
  try {
    const text =
      JSON.stringify({ "": value }[""], function (this: unknown, key: string, v: unknown) {
        const raw = (this as Record<string, unknown> | undefined)?.[key];
        const rendered = renderable(raw, v);
        if (typeof rendered === "object" && rendered !== null) {
          // `this` is the holder of the current key; unwind to it so the stack
          // reflects the path from the root rather than traversal order.
          while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
            ancestors.pop();
          }
          if (ancestors.includes(rendered)) return "[Circular]";
          ancestors.push(rendered);
        }
        return rendered;
      }) ?? String(value);
    return truncate(text);
  } catch {
    return "[unserializable]";
  }
}

const SCALAR_TYPES: readonly string[] = ["string", "number", "boolean"];

/**
 * A value OTel will store as it is, else its bounded JSON encoding; `undefined`
 * for `null` / `undefined`, which mean "not set" rather than an empty string.
 *
 * OTel accepts a scalar or a HOMOGENEOUS scalar array and nothing else.
 * Anything else (a nested `response_format` object, a heterogeneous list like
 * `[1, "a"]`, a tool-choice object) is JSON-encoded rather than dropped: the
 * value really was sent, and a string is a worse answer than a typed scalar
 * but a much better one than silence. Unencoded, OTel would discard the
 * attribute with a warning and it would never reach the span. Booleans and
 * numbers are separate element types, so `[true, 1]` is encoded too.
 *
 * Byte objects are walked first (see {@link byteAttributeValue}): one alone
 * is the bare marker string, and an array of byte objects and strings is an
 * array of strings. A walked value OTel cannot hold (a mapping, a nested
 * array) is set as the value's JSON, its byte objects quoted markers.
 */
export function attributeValue(value: unknown): AttributeValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (isByteObject(value)) return byteObjectMarker(value);
  if (Array.isArray(value)) {
    let items: unknown;
    try {
      items = byteAttributeValue(value);
    } catch {
      // Out of stack on a deep array: its JSON is still bounded and safe.
      return toAttributeValue(value);
    }
    if (typeof items === "string") return items;
    // Homogeneous as OTel JS reads it: null aside, all strings, numbers or booleans.
    const list = items as unknown[];
    const types = new Set(list.filter((v) => v !== null && v !== undefined).map((v) => typeof v));
    const [type = "string"] = types;
    if (types.size <= 1 && SCALAR_TYPES.includes(type)) return list as AttributeValue;
  }
  return toAttributeValue(value);
}

/**
 * A value with every byte object in it, at any depth of its arrays, the bare
 * marker string. OTel arrays are homogeneous, so each array is looked at on
 * its own once its elements are walked: one that held a byte object beside
 * an element that is then no string is its JSON instead, one string. Any
 * other value is kept (a mapping can only sit in an array OTel cannot hold,
 * which the caller encodes whole), and a cycle is left as it came for the
 * JSON encoding to mark.
 */
function byteAttributeValue(value: unknown, ancestors: unknown[] = []): unknown {
  if (isByteObject(value)) return byteObjectMarker(value);
  if (!Array.isArray(value) || ancestors.includes(value)) return value;
  ancestors.push(value);
  try {
    const items = value.map((v) => byteAttributeValue(v, ancestors));
    const mixed = value.some(isByteObject) && !items.every((v) => typeof v === "string");
    return mixed ? toAttributeValue(value) : items;
  } finally {
    ancestors.pop();
  }
}
