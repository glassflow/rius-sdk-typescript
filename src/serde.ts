import type { AttributeValue } from "@opentelemetry/api";

/**
 * Serialized payload cap, in characters, shared with the Python SDK so a
 * payload lands the same size whichever SDK produced it. Applies to every
 * string this module produces: JSON-encoded objects and bare strings alike.
 * Without it a 5 MB tool result was a 5 MB span (2026-09 review).
 */
export const MAX_ATTR_CHARS = 32 * 1024;

/** Appended to a cut payload; the same marker the Python SDK writes. */
export const TRUNCATION_MARKER = "…(truncated)";

/** Cut `text` at the attribute cap, marking the cut. */
export function truncate(text: string): string {
  return text.length > MAX_ATTR_CHARS ? text.slice(0, MAX_ATTR_CHARS) + TRUNCATION_MARKER : text;
}

/**
 * Values JSON.stringify cannot render as data, made renderable. Called from
 * the replacer with the HOLDER's original property, not the value the
 * replacer receives: JSON.stringify runs `toJSON` first, so a Buffer would
 * already have become `{type: "Buffer", data: [...]}` by then.
 */
function renderable(raw: unknown, value: unknown): unknown {
  if (typeof raw === "bigint") return String(raw);
  if (raw instanceof Map) return Object.fromEntries(raw);
  if (raw instanceof Set) return [...raw];
  if (ArrayBuffer.isView(raw)) {
    // Bytes are not content a trace can show; a size is, and a byte array
    // exploded into JSON was many times the payload's own size.
    return `<${raw.constructor.name} ${raw.byteLength} bytes>`;
  }
  if (raw instanceof ArrayBuffer) return `<ArrayBuffer ${raw.byteLength} bytes>`;
  return value;
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
 */
export function attributeValue(value: unknown): AttributeValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string")) return value as string[];
    if (value.every((v) => typeof v === "number")) return value as number[];
    if (value.every((v) => typeof v === "boolean")) return value as boolean[];
  }
  return toAttributeValue(value);
}
