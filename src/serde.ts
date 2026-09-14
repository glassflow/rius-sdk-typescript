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
 * Coerce an arbitrary value into something an OTel attribute accepts, bounded
 * by {@link MAX_ATTR_CHARS}. Must never throw: this runs on the user's data on
 * the hot path.
 */
export function toAttributeValue(value: unknown): string | number | boolean {
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value === null || value === undefined) return "";
  // Track the ANCESTOR chain, not every object seen. A global seen-set would
  // report a shared sibling reference ({ a: x, b: x }) as circular and drop
  // real data, which is a plausible shape in LLM message payloads.
  const ancestors: unknown[] = [];
  try {
    const text =
      JSON.stringify(value, function (this: unknown, _key: string, v: unknown) {
        if (typeof v === "object" && v !== null) {
          // `this` is the holder of the current key; unwind to it so the stack
          // reflects the path from the root rather than traversal order.
          while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
            ancestors.pop();
          }
          if (ancestors.includes(v)) return "[Circular]";
          ancestors.push(v);
        }
        return v;
      }) ?? String(value);
    return truncate(text);
  } catch {
    return "[unserializable]";
  }
}
