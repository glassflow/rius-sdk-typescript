/**
 * Coerce an arbitrary value into something an OTel attribute accepts.
 * Must never throw: this runs on the user's data on the hot path.
 */
export function toAttributeValue(value: unknown): string | number | boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === null || value === undefined) return "";
  try {
    const seen = new WeakSet<object>();
    return (
      JSON.stringify(value, (_key, v) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
        }
        return v;
      }) ?? String(value)
    );
  } catch {
    return "[unserializable]";
  }
}
