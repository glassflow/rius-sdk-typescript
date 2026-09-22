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

describe("contextSizes constants", () => {
  it("pins the wire constants", () => {
    expect(SIZES_VERSION).toBe(1);
    expect(DETAIL_WINDOW).toBe(50);
    expect(MAX_SIZES_BYTES).toBe(8192);
  });
});

describe("contextSizes shape", () => {
  it("emits only the version when nothing was set", () => {
    expect(contextSizes(undefined, undefined, undefined)).toBe('{"v":1}');
  });

  it("writes compact JSON with keys in v, t, i, o, c order", () => {
    const out = contextSizes(
      [{ name: "a" }],
      [msg("user", text("hi", { cache_control: { type: "ephemeral" } }))],
      [msg("assistant", text("yo"))],
    );
    expect(out).toBe('{"v":1,"t":[["a",12]],"i":[["u",2]],"o":[["a",2]],"c":0}');
  });

  it("omits t / i / o when the corresponding argument is undefined", () => {
    expect(
      Object.keys(parse(contextSizes(undefined, [msg("user", text("x"))], undefined))),
    ).toEqual(["v", "i"]);
    expect(Object.keys(parse(contextSizes([], undefined, [])))).toEqual(["v", "t", "o"]);
  });
});

describe("tool definitions", () => {
  it("names OpenAI, Anthropic and unnamed tools and measures canonical bytes", () => {
    const openai = { type: "function", function: { name: "query", parameters: { a: 1 } } };
    const anthropic = { name: "status", input_schema: { type: "object" } };
    const builtin = { type: "web_search", max_uses: 3 };
    const out = parse(contextSizes([openai, anthropic, builtin], undefined, undefined));
    expect(out.t).toEqual([
      ["query", bytes(openai)],
      ["status", bytes(anthropic)],
      [null, bytes(builtin)],
    ]);
  });

  it("yields a null name and zero bytes for a non-object tool that cannot be measured", () => {
    const out = parse(contextSizes([undefined, 7], undefined, undefined));
    expect(out.t).toEqual([
      [null, 0],
      [null, 1],
    ]);
  });
});

describe("roles", () => {
  it("codes the known roles and passes the rest through literally", () => {
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
    expect(out.i).toEqual([
      ["s", 1],
      ["s", 1],
      ["u", 1],
      ["a", 1],
      ["t", 1],
      ["t", 1],
      ["moderator", 1],
      ["42", 1],
    ]);
  });
});

describe("text parts", () => {
  it("measures UTF-8 bytes, not characters", () => {
    const cjk = "状態を確認して"; // 7 chars, 21 bytes
    const emoji = "🚨"; // 1 char (2 UTF-16 units), 4 bytes
    const out = parse(contextSizes(undefined, [msg("user", text(cjk), text(emoji))], undefined));
    expect(cjk.length).toBe(7);
    expect(out.i).toEqual([["u", 21, 4]]);
  });

  it("measures non-string text content as canonical JSON bytes", () => {
    const out = parse(
      contextSizes(undefined, [msg("user", text({ k: "v" }), text(12))], undefined),
    );
    expect(out.i).toEqual([["u", 9, 2]]);
  });

  it("measures a missing content as JSON null, matching the Python side", () => {
    const out = parse(contextSizes(undefined, [msg("user", { type: "text" })], undefined));
    expect(out.i).toEqual([["u", 4]]);
  });
});

describe("tool call parts", () => {
  const tools = [{ name: "search" }, { function: { name: "status" } }];

  it("references a defined tool by index, an undefined one by name, a missing one as null", () => {
    const p1 = call("c1", "status");
    const p2 = call("c2", "other");
    const p3 = call("c3", undefined);
    const out = parse(contextSizes(tools, [msg("assistant", p1, p2, p3)], undefined));
    expect(out.i).toEqual([
      ["a", ["c", 1, bytes(p1)], ["c", "other", bytes(p2)], ["c", null, bytes(p3)]],
    ]);
  });

  it("uses the first matching tool when two definitions share a name", () => {
    const out = parse(
      contextSizes(
        [{ name: "dup" }, { name: "dup" }],
        [msg("assistant", call("c", "dup"))],
        undefined,
      ),
    );
    expect((out.i as unknown[][])[0][1]).toEqual(["c", 0, bytes(call("c", "dup"))]);
  });

  it("resolves a tool result's tool through the call id, across all messages", () => {
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
    expect(out.i).toEqual([
      ["a", ["c", 1, bytes(call("c1", "status"))], ["c", "other", bytes(call("c2", "other"))]],
      ["t", ["r", 1, bytes(r1)]],
      ["t", ["r", "other", bytes(r2)]],
      ["t", ["r", null, bytes(r3)]],
      ["t", ["r", null, bytes(r4)]],
    ]);
  });

  it("builds the id map over input messages before output messages", () => {
    // The result in the input refers to a call that only appears in the output.
    const r = result("late", "ok");
    const out = parse(
      contextSizes(tools, [msg("tool", r)], [msg("assistant", call("late", "search"))]),
    );
    expect(out.i).toEqual([["t", ["r", 0, bytes(r)]]]);
  });

  it("measures an orphan tool result (role tool, no call id) as a text part", () => {
    // The normalizer turns such a message into a plain text part.
    const out = parse(contextSizes(undefined, [msg("tool", text("orphan"))], undefined));
    expect(out.i).toEqual([["t", 6]]);
  });
});

describe("other parts", () => {
  it("records media and unknown parts as a typed marker without a size", () => {
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
    expect(out.i).toEqual([
      [
        "u",
        ["m", "image_url"],
        ["m", "audio"],
        ["m", "unknown"],
        ["m", "unknown"],
        ["m", "unknown"],
      ],
    ]);
  });

  it("treats a message whose parts are not a list as having no parts", () => {
    const out = parse(contextSizes(undefined, [{ role: "user", parts: "x" }, 5], undefined));
    expect((out.i as unknown[]).length).toBe(2);
    expect((out.i as unknown[])[0]).toEqual(["u"]);
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
    expect(out.c).toBe(1);
  });

  it("is omitted when no input part carries a cache marker", () => {
    const out = parse(contextSizes(undefined, [msg("user", text("a"))], undefined));
    expect("c" in out).toBe(false);
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
    expect((out.i as unknown[]).length).toBe(DETAIL_WINDOW);
    expect("f" in out).toBe(false);

    const folded = parse(contextSizes(undefined, longInput(DETAIL_WINDOW + 1), undefined));
    expect((folded.i as unknown[]).length).toBe(DETAIL_WINDOW);
    expect((folded.i as unknown[][])[0]).toEqual(["u", 3, ["m", "image_url"]]); // message 1 survives
    expect(folded.f).toEqual({ n: 1, s: 2 });
  });

  it("aggregates the folded messages per role, per tool, and counts media parts", () => {
    const tools = [{ name: "status" }];
    const input = longInput(60); // folds the first 10: indices 0..9, two of each kind
    const out = parse(contextSizes(tools, input, undefined));
    const callBytes = bytes(call("c2", "status")) + bytes(call("c7", "status"));
    const resultBytes = bytes(result("c2", "r")) + bytes(result("c7", "r"));
    expect(out.f).toEqual({
      n: 10,
      s: 4,
      u: 6 + 8, // two user texts plus two literal-role texts folded into "u"
      a: 2,
      t: [[0, callBytes + resultBytes]],
      m: 2,
    });
    expect(Object.keys(out.f as object)).toEqual(["n", "s", "u", "a", "t", "m"]);
  });

  it("keeps separate tool sums for index, name and null references, in first-seen order", () => {
    const input = [
      msg("assistant", call("x1", "named"), call("x2", "status"), call("x3", undefined)),
      ...longInput(DETAIL_WINDOW),
    ];
    const out = parse(contextSizes([{ name: "status" }], input, undefined));
    const f = out.f as { t: unknown[][] };
    expect(f.t.map((e) => e[0])).toEqual(["named", 0, null]);
  });

  it("leaves the cache index pre-folding and never folds the output", () => {
    const input = longInput(70);
    input[3].parts[0].cache_control = { type: "ephemeral" };
    const out = parse(contextSizes(undefined, input, longInput(70)));
    expect(out.c).toBe(3);
    expect((out.o as unknown[]).length).toBe(70);
  });

  it("puts the cache index in the wire order between o and f", () => {
    const input = longInput(70);
    input[0].parts[0].cache_control = { type: "ephemeral" };
    const out = contextSizes(undefined, input, [msg("assistant", text("x"))]);
    expect(out.indexOf('"o":')).toBeLessThan(out.indexOf('"c":'));
    expect(out.indexOf('"c":')).toBeLessThan(out.indexOf('"f":'));
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
    expect(parsed.v).toBe(1);
    expect((parsed.i as unknown[]).length).toBeLessThan(DETAIL_WINDOW);
    expect((parsed.f as { n: number }).n).toBe(600 - (parsed.i as unknown[]).length);
  });

  it("stops at a zero window rather than truncating the string", () => {
    // Every message alone is wider than the cap: the window reaches 0 and the
    // attribute is a valid (if large) fold, never a cut string.
    const huge = "x".repeat(9000);
    const messages = Array.from({ length: 3 }, (_, k) => msg("assistant", call(`c${k}`, huge)));
    const out = contextSizes(undefined, messages, undefined);
    const parsed = parse(out);
    expect(parsed.i).toEqual([]);
    expect((parsed.f as { n: number }).n).toBe(3);
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
    expect(out.t).toEqual([[null, 0]]);
    expect(out.i).toEqual([["u", 0]]);
  });
});
