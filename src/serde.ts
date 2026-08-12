/**
 * Coerce an arbitrary value into something an OTel attribute accepts.
 * Must never throw: this runs on the user's data on the hot path.
 */
export function toAttributeValue(value: unknown): string | number | boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === null || value === undefined) return "";
  // Track the ANCESTOR chain, not every object seen. A global seen-set would
  // report a shared sibling reference ({ a: x, b: x }) as circular and drop
  // real data, which is a plausible shape in LLM message payloads.
  const ancestors: unknown[] = [];
  try {
    return (
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
      }) ?? String(value)
    );
  } catch {
    return "[unserializable]";
  }
}
