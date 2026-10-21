import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { errorType } from "../src/errorType.js";
import { toAttributeValue } from "../src/serde.js";
import { CONTRACT } from "./mediaContract.js";

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

describe("a byte object in a serialized value", () => {
  const examples = CONTRACT.raw_payloads.byte_objects.examples.filter(
    (e) => e.language === "typescript",
  );

  /** Each TypeScript byte_objects example's value, built as the example writes it. */
  const VALUES: Record<string, () => unknown> = {
    typescript_uint8array: () => ({ u: new Uint8Array(3) }),
    typescript_node_buffer_is_a_byte_object: () => ({
      type: "file",
      data: Buffer.from([137, 80, 78, 71]),
      mediaType: "image/png",
    }),
    typescript_typed_array_counts_bytes_not_items: () => new Uint16Array(2),
    typescript_array_buffer_and_data_view: () => [
      new ArrayBuffer(5),
      new DataView(new ArrayBuffer(8), 2, 3),
    ],
  };

  it("covers every TypeScript example of the contract", () => {
    expect(Object.keys(VALUES).sort()).toEqual(examples.map((e) => e.name).sort());
  });

  it.each(examples.map((e) => [e.name, e] as const))("%s, byte for byte", (name, example) => {
    expect(toAttributeValue(VALUES[name]())).toBe(example.output);
  });

  it.each([
    ["a SharedArrayBuffer", new SharedArrayBuffer(6), '"[stripped unknown 6 bytes]"'],
    [
      "a Float64Array (8 bytes an item)",
      { f: new Float64Array(2) },
      '{"f":"[stripped unknown 16 bytes]"}',
    ],
    [
      "a Buffer cut from a larger one (its own length)",
      { b: Buffer.from("abcdefgh").subarray(2, 5) },
      '{"b":"[stripped unknown 3 bytes]"}',
    ],
    ["an empty Buffer", [Buffer.alloc(0)], '["[stripped unknown 0 bytes]"]'],
    [
      "bytes in a Map and a Set",
      { m: new Map([["k", new Uint8Array(2)]]), s: new Set([new Int32Array(1)]) },
      '{"m":{"k":"[stripped unknown 2 bytes]"},"s":["[stripped unknown 4 bytes]"]}',
    ],
  ])("writes %s as the marker", (_name, value, output) => {
    expect(toAttributeValue(value)).toBe(output);
  });

  it("never writes a Buffer's toJSON object or its bytes", () => {
    const text = toAttributeValue({ a: { b: [Buffer.from([1, 2, 3])] } }) as string;
    expect(text).toBe('{"a":{"b":["[stripped unknown 3 bytes]"]}}');
    expect(text).not.toContain('"Buffer"');
  });

  it.each([
    ["a Uint8Array", "new Uint8Array(3)", 3],
    ["a DataView", "new DataView(new ArrayBuffer(8), 1, 2)", 2],
    ["an ArrayBuffer", "new ArrayBuffer(5)", 5],
    ["a SharedArrayBuffer", "new SharedArrayBuffer(6)", 6],
  ])("writes %s from another realm as the marker", (_name, code, size) => {
    const value = runInNewContext(`({ v: ${code} })`);
    expect(toAttributeValue(value)).toBe(`{"v":"[stripped unknown ${size} bytes]"}`);
  });
});

describe("errorType", () => {
  it("is the error's name, the spelling exception.type uses", () => {
    expect(errorType(new Error("boom"))).toBe("Error");
    expect(errorType(new TypeError("boom"))).toBe("TypeError");
  });

  it("uses a subclass's own name, never the message", () => {
    class ProviderDown extends Error {
      constructor(message: string) {
        super(message);
        this.name = "ProviderDown";
      }
    }
    expect(errorType(new ProviderDown("rate limited: request body echoed"))).toBe("ProviderDown");
  });

  it("falls back to the runtime type for a non-Error throwable", () => {
    expect(errorType("just a string")).toBe("string");
    expect(errorType(42)).toBe("number");
  });
});
