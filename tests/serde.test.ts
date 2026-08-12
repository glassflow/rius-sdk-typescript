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
});
