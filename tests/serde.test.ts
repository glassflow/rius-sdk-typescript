import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { errorType } from "../src/errorType.js";
import { attributeValue, byteAttributeValue, toAttributeValue } from "../src/serde.js";
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

describe("a byte object set as an attribute value", () => {
  it.each([
    ["a Buffer", Buffer.from([137, 80, 78, 71]), "[stripped unknown 4 bytes]"],
    ["a Uint16Array (2 bytes an item)", new Uint16Array(3), "[stripped unknown 6 bytes]"],
    ["an ArrayBuffer", new ArrayBuffer(0), "[stripped unknown 0 bytes]"],
    ["a DataView", new DataView(new ArrayBuffer(8), 4), "[stripped unknown 4 bytes]"],
    [
      "a Uint8Array from another realm",
      runInNewContext("new Uint8Array(2)"),
      "[stripped unknown 2 bytes]",
    ],
  ])("is %s as the bare marker, with no JSON quotes", (_name, value, marker) => {
    expect(attributeValue(value)).toBe(marker);
  });

  it("is each byte object element of an array as the bare marker", () => {
    expect(
      attributeValue([Buffer.from("ab"), new Uint8Array(3), new SharedArrayBuffer(8)]),
    ).toEqual([
      "[stripped unknown 2 bytes]",
      "[stripped unknown 3 bytes]",
      "[stripped unknown 8 bytes]",
    ]);
    expect(attributeValue(["plain", new Uint8Array(1)])).toEqual([
      "plain",
      "[stripped unknown 1 bytes]",
    ]);
  });

  it("keeps an array with other kinds of element JSON-encoded, its bytes as the marker", () => {
    expect(attributeValue([1, new Uint8Array(2)])).toBe('[1,"[stripped unknown 2 bytes]"]');
  });
});

describe("the contract's attribute values", () => {
  const examples = CONTRACT.raw_payloads.byte_objects.attribute_values.examples.filter(
    (e) => e.language === "typescript",
  );

  /** Each TypeScript attribute_values example's value, built as the example writes it. */
  const VALUES: Record<string, () => unknown> = {
    typescript_buffer_attribute: () => Buffer.from([137, 80, 78, 71]),
    typescript_byte_objects_in_an_array_attribute: () => [new Uint8Array(2), new ArrayBuffer(3)],
    typescript_byte_objects_in_a_mapping_and_a_nested_array: () => ({
      k: new Uint16Array(2),
      n: [[new DataView(new ArrayBuffer(3))], ["x"]],
    }),
    typescript_byte_object_beside_a_number: () => [1, new Uint8Array(2)],
  };

  it("covers every TypeScript example of the contract", () => {
    expect(Object.keys(VALUES).sort()).toEqual(examples.map((e) => e.name).sort());
  });

  it.each(examples.map((e) => [e.name, e] as const))("%s, walked", (name, example) => {
    expect(byteAttributeValue(VALUES[name]())).toEqual(example.output);
  });

  // OTel holds a string or a homogeneous array of them and nothing deeper: a
  // walked value it cannot hold (a mapping) is set as the value's JSON.
  it.each(examples.map((e) => [e.name, e] as const))(
    "%s, as the span holds it",
    (name, example) => {
      const value = attributeValue(VALUES[name]());
      if (typeof example.output === "object" && !Array.isArray(example.output)) {
        expect(JSON.parse(value as string)).toEqual(example.output);
      } else {
        expect(value).toEqual(example.output);
      }
    },
  );
});

describe("an array attribute value holding a byte object", () => {
  const u8 = (n: number) => new Uint8Array(n);
  const m = (n: number) => `[stripped unknown ${n} bytes]`;

  it.each([
    ["beside a bool, is its JSON", [true, u8(2)], `[true,"${m(2)}"]`],
    ["beside null, is its JSON", [null, u8(2)], `[null,"${m(2)}"]`],
    ["beside an array, is its JSON", [u8(2), [u8(1)]], `["${m(2)}",["${m(1)}"]]`],
    ["beside a mapping, is its JSON", [u8(2), { k: "v" }], `["${m(2)}",{"k":"v"}]`],
    ["nested beside a number, is a string of its JSON", [[1, u8(1)]], [`[1,"${m(1)}"]`]],
    [
      "nested beside strings, keeps the array of strings",
      ["x", [1, u8(1)]],
      ["x", `[1,"${m(1)}"]`],
    ],
    ["nested alone, is no string, so the whole is JSON", [1, [u8(1)]], `[1,["${m(1)}"]]`],
    ["in a mapping, is the mapping's JSON", { k: [1, u8(1)] }, `{"k":[1,"${m(1)}"]}`],
  ])("%s", (_name, value, output) => {
    expect(attributeValue(value)).toEqual(output);
  });

  it("never fails on a cycle through an array", () => {
    const value: unknown[] = [u8(1)];
    value.push(value);
    expect(() => attributeValue(value)).not.toThrow();
  });
});

describe("a lone surrogate in a serialized value", () => {
  it("is written as its lower-case \\uXXXX escape, as the reference writes it", () => {
    expect(toAttributeValue({ s: "a\ud83db\udc00" })).toBe('{"s":"a\\ud83db\\udc00"}');
  });
});
