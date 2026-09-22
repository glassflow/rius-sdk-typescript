import { describe, expect, it } from "vitest";
import { normalizeMessages, serializeMessages } from "../src/messages.js";
import { toAttributeValue } from "../src/serde.js";

describe("normalizeMessages", () => {
  const input = [
    "hello",
    { role: "assistant", content: "hi", tool_calls: [{ id: "c1", function: { name: "f" } }] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
    { role: "user", parts: [{ type: "text", content: "spec" }] },
  ];

  it("returns the normalized {role, parts} list the serializer writes", () => {
    expect(normalizeMessages(input, "user")).toEqual([
      { role: "user", parts: [{ type: "text", content: "hello" }] },
      {
        role: "assistant",
        parts: [
          { type: "text", content: "hi" },
          // absent arguments are null, not dropped: same bytes as the Python SDK
          { type: "tool_call", id: "c1", name: "f", arguments: null },
        ],
      },
      { role: "tool", parts: [{ type: "tool_call_response", id: "c1", response: "ok" }] },
      { role: "user", parts: [{ type: "text", content: "spec" }] },
    ]);
  });

  it("writes null for a tool response without content, as the Python SDK does", () => {
    expect(normalizeMessages([{ role: "tool", tool_call_id: "c9" }], "user")).toEqual([
      { role: "tool", parts: [{ type: "tool_call_response", id: "c9", response: null }] },
    ]);
  });

  it("wraps a single message into a list", () => {
    expect(normalizeMessages("x", "assistant")).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "x" }] },
    ]);
  });

  it("is what serializeMessages serializes, so both consumers see one normalization", () => {
    expect(serializeMessages(input, "user")).toBe(
      toAttributeValue(normalizeMessages(input, "user")),
    );
  });
});
