import { describe, expect, it } from "vitest";
import { toAttributeValue } from "../src/serde.js";

describe("toAttributeValue", () => {
  it("passes primitives through untouched", () => {
    expect(toAttributeValue("s")).toBe("s");
    expect(toAttributeValue(1)).toBe(1);
    expect(toAttributeValue(true)).toBe(true);
  });

  it("JSON-encodes objects and arrays", () => {
    expect(toAttributeValue({ a: 1 })).toBe('{"a":1}');
    expect(toAttributeValue([1, "x"])).toBe('[1,"x"]');
  });

  it("never throws on circular structures", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => toAttributeValue(circular)).not.toThrow();
    expect(typeof toAttributeValue(circular)).toBe("string");
  });

  it("never throws on values that fail to serialize", () => {
    const hostile = {
      toJSON() {
        throw new Error("nope");
      },
    };
    expect(() => toAttributeValue(hostile)).not.toThrow();
  });

  it("never throws on BigInt and returns permitted type", () => {
    const big = BigInt(9007199254740992);
    expect(() => toAttributeValue(big)).not.toThrow();
    const result = toAttributeValue(big);
    expect(
      typeof result === "string" || typeof result === "number" || typeof result === "boolean",
    ).toBe(true);
  });

  it("serializes shared sibling references fully without false circular detection", () => {
    const shared = { role: "system", content: "you are helpful" };
    const result = toAttributeValue({ first: shared, second: shared });
    const parsed = JSON.parse(result as string);
    // Both first and second should have the full shared object, not [Circular]
    expect(parsed.first).toEqual({ role: "system", content: "you are helpful" });
    expect(parsed.second).toEqual({ role: "system", content: "you are helpful" });
    // Verify no [Circular] marker exists anywhere in the output
    expect(result).not.toContain("[Circular]");
  });

  it("still detects self-reference as circular", () => {
    const selfRef: Record<string, unknown> = {};
    selfRef.self = selfRef;
    const result = toAttributeValue(selfRef);
    expect(result).toContain("[Circular]");
  });

  it("detects deeper cycles and marks them circular", () => {
    const obj: Record<string, unknown> = { value: "test" };
    const child: Record<string, unknown> = {};
    obj.child = child;
    child.parent = obj;
    const result = toAttributeValue(obj);
    expect(result).toContain("[Circular]");
  });

  it("serializes shared references at different depths fully", () => {
    const shared = { id: 42 };
    const nested = { x: shared, y: { z: shared } };
    const result = toAttributeValue(nested);
    const parsed = JSON.parse(result as string);
    // Both references to shared should be serialized fully
    expect(parsed.x).toEqual({ id: 42 });
    expect(parsed.y.z).toEqual({ id: 42 });
    // No [Circular] marker
    expect(result).not.toContain("[Circular]");
  });
});
