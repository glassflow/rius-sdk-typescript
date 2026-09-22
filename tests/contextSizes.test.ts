import { describe, expect, it } from "vitest";
import {
  DETAIL_WINDOW,
  MAX_SIZES_BYTES,
  SIZES_VERSION,
  contextSizes,
} from "../src/contextSizes.js";

type Part = Record<string, unknown>;
const msg = (role: unknown, ...parts: Part[]) => ({ role, parts });
const text = (content: unknown, extra: Part = {}): Part => ({ type: "text", content, ...extra });
const call = (id: string, name: unknown, args: unknown = "{}"): Part => ({
  type: "tool_call",
  id,
  name,
  arguments: args,
});
const result = (id: string | undefined, response: unknown): Part =>
  id === undefined
    ? { type: "tool_call_response", response }
    : { type: "tool_call_response", id, response };

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

// Expected-shape builders, so a test reads as the wire object it asserts.
const textPart = (n: number) => ({ type: "text", bytes: n });
const callPart = (tool: string | null, n: number) => ({ type: "tool_call", tool, bytes: n });
const resultPart = (tool: string | null, n: number) => ({
  type: "tool_call_response",
  tool,
  bytes: n,
});
const media = (type: string) => ({ type });
const message = (role: string, ...parts: unknown[]) => ({ role, parts });

describe("contextSizes constants", () => {
  it("pins the wire constants", () => {
    expect(SIZES_VERSION).toBe(1);
    expect(DETAIL_WINDOW).toBe(50);
    expect(MAX_SIZES_BYTES).toBe(8192);
  });
});

describe("contextSizes shape", () => {
  it("emits only the version when nothing was set", () => {
    expect(contextSizes(undefined, undefined, undefined)).toBe('{"version":1}');
  });

  it("writes compact JSON with the top-level keys in wire order", () => {
    const out = contextSizes(
      [{ name: "a" }],
      [msg("user", text("hi", { cache_control: { type: "ephemeral" } }))],
      [msg("assistant", text("yo"))],
    );
    expect(out).toBe(
      '{"version":1,"tool_definitions":[{"name":"a","bytes":12}],' +
        '"input_messages":[{"role":"user","parts":[{"type":"text","bytes":2}]}],' +
        '"output_messages":[{"role":"assistant","parts":[{"type":"text","bytes":2}]}],' +
        '"cache_marker":0}',
    );
  });

  it("omits the tools / input / output keys when the argument is undefined", () => {
    expect(
      Object.keys(parse(contextSizes(undefined, [msg("user", text("x"))], undefined))),
    ).toEqual(["version", "input_messages"]);
    expect(Object.keys(parse(contextSizes([], undefined, [])))).toEqual([
      "version",
      "tool_definitions",
      "output_messages",
    ]);
  });
});

describe("tool definitions", () => {
  it("names OpenAI, Anthropic and unnamed tools and measures canonical bytes", () => {
    const openai = { type: "function", function: { name: "query", parameters: { a: 1 } } };
    const anthropic = { name: "status", input_schema: { type: "object" } };
    const builtin = { type: "web_search", max_uses: 3 };
    const out = parse(contextSizes([openai, anthropic, builtin], undefined, undefined));
    expect(out.tool_definitions).toEqual([
      { name: "query", bytes: bytes(openai) },
      { name: "status", bytes: bytes(anthropic) },
      { name: null, bytes: bytes(builtin) },
    ]);
  });

  it("yields a null name and zero bytes for a non-object tool that cannot be measured", () => {
    const out = parse(contextSizes([undefined, 7], undefined, undefined));
    expect(out.tool_definitions).toEqual([
      { name: null, bytes: 0 },
      { name: null, bytes: 1 },
    ]);
  });
});

describe("roles", () => {
  it("keeps every role literal, stringifying a non-string one", () => {
    const out = parse(
      contextSizes(
        undefined,
        [
          msg("system", text("a")),
          msg("developer", text("b")),
          msg("user", text("c")),
          msg("assistant", text("d")),
          msg("tool", text("e")),
          msg("function", text("f")),
          msg("moderator", text("g")),
          msg(42, text("h")),
        ],
        undefined,
      ),
    );
    expect((out.input_messages as { role: string }[]).map((m) => m.role)).toEqual([
      "system",
      "developer",
      "user",
      "assistant",
      "tool",
      "function",
      "moderator",
      "42",
    ]);
  });
});

describe("text parts", () => {
  it("measures UTF-8 bytes, not characters", () => {
    const cjk = "状態を確認して"; // 7 chars, 21 bytes
    const emoji = "🚨"; // 1 char (2 UTF-16 units), 4 bytes
    const out = parse(contextSizes(undefined, [msg("user", text(cjk), text(emoji))], undefined));
    expect(cjk.length).toBe(7);
    expect(out.input_messages).toEqual([message("user", textPart(21), textPart(4))]);
  });

  it("measures non-string text content as canonical JSON bytes", () => {
    const out = parse(
      contextSizes(undefined, [msg("user", text({ k: "v" }), text(12))], undefined),
    );
    expect(out.input_messages).toEqual([message("user", textPart(9), textPart(2))]);
  });

  it("measures a missing content as JSON null, matching the Python side", () => {
    const out = parse(contextSizes(undefined, [msg("user", { type: "text" })], undefined));
    expect(out.input_messages).toEqual([message("user", textPart(4))]);
  });
});

describe("tool call parts", () => {
  const tools = [{ name: "search" }, { function: { name: "status" } }];

  it("names the tool whether or not it is defined, null when the call has no name", () => {
    const p1 = call("c1", "status");
    const p2 = call("c2", "other");
    const p3 = call("c3", undefined);
    const p4 = call("c4", 7);
    const out = parse(contextSizes(tools, [msg("assistant", p1, p2, p3, p4)], undefined));
    expect(out.input_messages).toEqual([
      message(
        "assistant",
        callPart("status", bytes(p1)),
        callPart("other", bytes(p2)),
        callPart(null, bytes(p3)),
        callPart(null, bytes(p4)),
      ),
    ]);
  });

  it("resolves a tool result's tool name through the call id, across all messages", () => {
    const r1 = result("c1", "ok");
    const r2 = result("c2", "ok");
    const r3 = result("zzz", "ok");
    const r4 = result(undefined, "ok");
    const out = parse(
      contextSizes(
        tools,
        [
          msg("assistant", call("c1", "status"), call("c2", "other")),
          msg("tool", r1),
          msg("tool", r2),
          msg("tool", r3),
          msg("tool", r4),
        ],
        undefined,
      ),
    );
    expect((out.input_messages as unknown[]).slice(1)).toEqual([
      message("tool", resultPart("status", bytes(r1))),
      message("tool", resultPart("other", bytes(r2))),
      message("tool", resultPart(null, bytes(r3))),
      message("tool", resultPart(null, bytes(r4))),
    ]);
  });

  it("builds the id map over input messages before output messages", () => {
    // The result in the input refers to a call that only appears in the output.
    const r = result("late", "ok");
    const out = parse(
      contextSizes(tools, [msg("tool", r)], [msg("assistant", call("late", "search"))]),
    );
    expect(out.input_messages).toEqual([message("tool", resultPart("search", bytes(r)))]);
  });

  it("resolves a duplicated call id to the first call, as the Python SDK does", () => {
    const r = result("dup", "ok");
    const out = parse(
      contextSizes(
        undefined,
        [msg("assistant", call("dup", "first"), call("dup", "second")), msg("tool", r)],
        undefined,
      ),
    );
    expect((out.input_messages as unknown[])[1]).toEqual(
      message("tool", resultPart("first", bytes(r))),
    );
  });

  it("measures an orphan tool result (role tool, no call id) as a text part", () => {
    // The normalizer turns such a message into a plain text part.
    const out = parse(contextSizes(undefined, [msg("tool", text("orphan"))], undefined));
    expect(out.input_messages).toEqual([message("tool", textPart(6))]);
  });
});

describe("other parts", () => {
  it("records media and unknown parts by type only, without a size", () => {
    const out = parse(
      contextSizes(
        undefined,
        [
          msg(
            "user",
            { type: "image_url", image_url: { url: "data:..." } },
            { type: "audio" },
            { foo: "bar" },
            { type: 7 },
            "not a part" as unknown as Part,
          ),
        ],
        undefined,
      ),
    );
    expect(out.input_messages).toEqual([
      message(
        "user",
        media("image_url"),
        media("audio"),
        media("unknown"),
        media("unknown"),
        media("unknown"),
      ),
    ]);
  });

  it("treats a message whose parts are not a list as having no parts", () => {
    const out = parse(contextSizes(undefined, [{ role: "user", parts: "x" }, 5], undefined));
    expect((out.input_messages as unknown[]).length).toBe(2);
    expect((out.input_messages as unknown[])[0]).toEqual(message("user"));
  });
});

describe("cache marker", () => {
  it("points at the last input message with a non-null cache_control", () => {
    const out = parse(
      contextSizes(
        undefined,
        [
          msg("system", text("a", { cache_control: { type: "ephemeral" } })),
          msg("user", text("b"), text("c", { cache_control: { type: "ephemeral" } })),
          msg("user", text("d", { cache_control: null })),
        ],
        [msg("assistant", text("e", { cache_control: { type: "ephemeral" } }))],
      ),
    );
    expect(out.cache_marker).toBe(1);
  });

  it("is omitted when no input part carries a cache marker", () => {
    const out = parse(contextSizes(undefined, [msg("user", text("a"))], undefined));
    expect("cache_marker" in out).toBe(false);
  });
});

describe("folding", () => {
  function longInput(count: number) {
    const messages: Array<{ role: unknown; parts: Part[] }> = [];
    for (let k = 0; k < count; k++) {
      switch (k % 5) {
        case 0:
          messages.push(msg("system", text("ss")));
          break;
        case 1:
          messages.push(msg("user", text("uuu"), { type: "image_url" }));
          break;
        case 2:
          messages.push(msg("assistant", text("a"), call(`c${k}`, "status")));
          break;
        case 3:
          messages.push(msg("tool", result(`c${k - 1}`, "r")));
          break;
        default:
          messages.push(msg("moderator", text("mmmm")));
      }
    }
    return messages;
  }

  it("keeps per-part detail for exactly the last DETAIL_WINDOW messages", () => {
    const out = parse(contextSizes(undefined, longInput(DETAIL_WINDOW), undefined));
    expect((out.input_messages as unknown[]).length).toBe(DETAIL_WINDOW);
    expect("folded" in out).toBe(false);

    const folded = parse(contextSizes(undefined, longInput(DETAIL_WINDOW + 1), undefined));
    expect((folded.input_messages as unknown[]).length).toBe(DETAIL_WINDOW);
    // message 1 survives the fold
    expect((folded.input_messages as unknown[])[0]).toEqual(
      message("user", textPart(3), media("image_url")),
    );
    expect(folded.folded).toEqual({ messages: 1, system_bytes: 2 });
  });

  it("aggregates the folded messages per role, per tool name, and counts media parts", () => {
    const tools = [{ name: "status" }];
    const input = longInput(60); // folds the first 10: indices 0..9, two of each kind
    const out = parse(contextSizes(tools, input, undefined));
    const callBytes = bytes(call("c2", "status")) + bytes(call("c7", "status"));
    const resultBytes = bytes(result("c2", "r")) + bytes(result("c7", "r"));
    expect(out.folded).toEqual({
      messages: 10,
      system_bytes: 4,
      user_bytes: 6 + 8, // two user texts plus two literal-role texts, both user-side
      assistant_bytes: 2,
      tools: [{ tool: "status", bytes: callBytes + resultBytes }],
      multimodal_parts: 2,
    });
    expect(Object.keys(out.folded as object)).toEqual([
      "messages",
      "system_bytes",
      "user_bytes",
      "assistant_bytes",
      "tools",
      "multimodal_parts",
    ]);
  });

  it("buckets tool bytes per name with null as its own bucket, in first-seen order", () => {
    const input = [
      msg("assistant", call("x1", "named"), call("x2", "status"), call("x3", undefined)),
      ...longInput(DETAIL_WINDOW),
    ];
    const out = parse(contextSizes([{ name: "status" }], input, undefined));
    const folded = out.folded as { tools: { tool: unknown }[] };
    expect(folded.tools.map((e) => e.tool)).toEqual(["named", "status", null]);
  });

  it("leaves the cache marker pre-folding and never folds the output", () => {
    const input = longInput(70);
    input[3].parts[0].cache_control = { type: "ephemeral" };
    const out = parse(contextSizes(undefined, input, longInput(70)));
    expect(out.cache_marker).toBe(3);
    expect((out.output_messages as unknown[]).length).toBe(70);
  });

  it("puts the cache marker in the wire order between output_messages and folded", () => {
    const input = longInput(70);
    input[0].parts[0].cache_control = { type: "ephemeral" };
    const out = contextSizes(undefined, input, [msg("assistant", text("x"))]);
    expect(out.indexOf('"output_messages":')).toBeLessThan(out.indexOf('"cache_marker":'));
    expect(out.indexOf('"cache_marker":')).toBeLessThan(out.indexOf('"folded":'));
  });

  it("halves the detail window until the JSON fits in MAX_SIZES_BYTES", () => {
    const messages: Array<{ role: unknown; parts: Part[] }> = [];
    for (let k = 0; k < 600; k++) {
      const parts: Part[] = [];
      for (let j = 0; j < 12; j++) parts.push(call(`c${k}-${j}`, `tool_${j}`));
      messages.push(msg("assistant", ...parts));
    }
    const out = contextSizes(undefined, messages, undefined);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(MAX_SIZES_BYTES);
    const parsed = parse(out);
    expect(parsed.version).toBe(1);
    const detailed = (parsed.input_messages as unknown[]).length;
    expect(detailed).toBeLessThan(DETAIL_WINDOW);
    expect((parsed.folded as { messages: number }).messages).toBe(600 - detailed);
  });

  it("stops at a zero window rather than truncating the string", () => {
    // Every message alone is wider than the cap: the window reaches 0 and the
    // attribute is a valid (if large) fold, never a cut string.
    const huge = "x".repeat(9000);
    const messages = Array.from({ length: 3 }, (_, k) => msg("assistant", call(`c${k}`, huge)));
    const out = contextSizes(undefined, messages, undefined);
    const parsed = parse(out);
    expect(parsed.input_messages).toEqual([]);
    expect((parsed.folded as { messages: number }).messages).toBe(3);
  });
});

describe("robustness", () => {
  it("never throws on unexpected shapes", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      contextSizes(
        [circular, null, "tool"] as unknown[],
        [null, "str", { parts: [{ type: "tool_call", name: circular }] }],
        { not: "a list" } as unknown as unknown[],
      ),
    ).not.toThrow();
    const out = parse(
      contextSizes([circular], [{ role: "user", parts: [text(circular)] }], undefined),
    );
    expect(out.tool_definitions).toEqual([{ name: null, bytes: 0 }]);
    expect(out.input_messages).toEqual([message("user", textPart(0))]);
  });

  it("ignores a non-list messages argument as unset, matching the Python SDK", () => {
    expect(contextSizes(undefined, "hi" as unknown as unknown[], undefined)).toBe('{"version":1}');
  });
});
