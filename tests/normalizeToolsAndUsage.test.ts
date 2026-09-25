import { type Attributes, type Context, trace } from "@opentelemetry/api";
import type { ExportResult } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type Span,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { NormalizingSpanProcessor, normalizeToolDefinitions } from "../src/normalize.js";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_REQUEST_SEED,
  GEN_AI_TOOL_DEFINITIONS,
  GEN_AI_TOOL_NAME,
  GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS,
  GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  LLM_INVOCATION_PARAMETERS,
  RIUS_REQUEST_TOOL_CHOICE,
  RIUS_SPAN_PENDING,
} from "../src/semconv.js";
import { toAttributeValue } from "../src/serde.js";

/**
 * Tool identity, tool definitions and two usage spellings on third-party
 * spans, ported from the Python SDK (normalization.py's tool.name rule and
 * normalize_tool_definitions, plus the usage rules the sink maps) so both SDKs
 * and the sink put the same canonical span on the wire.
 *
 * Raw inputs come from a BARE OTel provider carrying only the processor under
 * test, never from init(): its pipeline already normalizes, so an input built
 * there would arrive with the mapping done and prove nothing.
 */

// What @arizeai/openinference-instrumentation-openai records for a chat
// request with function tools: one llm.tools.{i}.tool.json_schema per tool.
const OPENAI_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
  {
    type: "function",
    function: { name: "get_time", parameters: { type: "object", properties: {} } },
  },
];

// Anthropic's own shape (top-level name / input_schema), which must survive
// verbatim rather than be rewritten into OpenAI's.
const ANTHROPIC_TOOLS = [
  {
    name: "get_weather",
    description: "Weather for a city",
    input_schema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];

function indexed(tools: readonly unknown[]): Record<string, string> {
  return Object.fromEntries(
    tools.map((tool, i) => [`llm.tools.${i}.tool.json_schema`, JSON.stringify(tool)]),
  );
}

/** Records the attribute bag every span carries at onStart. */
class StartRecorder implements SpanProcessor {
  readonly atStart: Attributes[] = [];
  onStart(span: Span, _context: Context): void {
    this.atStart.push({ ...span.attributes });
  }
  onEnd(): void {}
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

/**
 * One span through a bare provider: the normalizer under test, then a
 * recorder of what a later processor sees at start, then an exporter.
 */
function run(
  attributes: Attributes,
  name = "ChatCompletion",
): { atStart: Attributes; exported: Attributes } {
  const recorder = new StartRecorder();
  const memory = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new NormalizingSpanProcessor(), recorder, new SimpleSpanProcessor(memory)],
  });
  provider.getTracer("raw").startSpan(name, { attributes }).end();
  const [span] = memory.getFinishedSpans();
  return { atStart: recorder.atStart[0], exported: { ...span.attributes } };
}

function exported(attributes: Attributes, name?: string): Attributes {
  return run(attributes, name).exported;
}

function definitions(attributes: Attributes): unknown {
  return JSON.parse(String(attributes[GEN_AI_TOOL_DEFINITIONS]));
}

function llmToolsKeys(attributes: Attributes): string[] {
  return Object.keys(attributes).filter((key) => key.startsWith("llm.tools"));
}

describe("gen_ai.tool.definitions from llm.tools.N.tool.json_schema", () => {
  it("turns openai function tools into one definitions array", () => {
    const out = exported({
      "openinference.span.kind": "LLM",
      "llm.provider": "openai",
      [LLM_INVOCATION_PARAMETERS]: JSON.stringify({ model: "gpt-4o", tool_choice: "auto" }),
      ...indexed(OPENAI_TOOLS),
    });
    expect(definitions(out)).toEqual(OPENAI_TOOLS);
    expect(out).toEqual({
      "openinference.span.kind": "LLM",
      [GEN_AI_OPERATION_NAME]: "chat",
      [GEN_AI_PROVIDER_NAME]: "openai",
      [GEN_AI_REQUEST_MODEL]: "gpt-4o",
      // promoted out of the bag, and the bag, now empty, goes with it
      [RIUS_REQUEST_TOOL_CHOICE]: "auto",
      [GEN_AI_TOOL_DEFINITIONS]: out[GEN_AI_TOOL_DEFINITIONS],
    });
    expect(llmToolsKeys(out)).toEqual([]);
  });

  it("keeps an anthropic input_schema verbatim", () => {
    const out = exported({
      "openinference.span.kind": "LLM",
      "llm.provider": "anthropic",
      "llm.request.model_name": "claude-sonnet-4-5",
      ...indexed(ANTHROPIC_TOOLS),
    });
    expect(definitions(out)).toEqual(ANTHROPIC_TOOLS);
    expect(llmToolsKeys(out)).toEqual([]);
  });

  it("is spelled exactly like the native path, compact JSON", () => {
    // One serializer for both paths, so a normalized span and a native one
    // carrying the same tools put the same string on the wire.
    const out = exported(indexed(ANTHROPIC_TOOLS));
    expect(out[GEN_AI_TOOL_DEFINITIONS]).toBe(toAttributeValue(ANTHROPIC_TOOLS));
    expect(out[GEN_AI_TOOL_DEFINITIONS]).toBe(JSON.stringify(ANTHROPIC_TOOLS));
  });

  it("orders by numeric index, not lexically and not by attribute order", () => {
    const tools = Array.from({ length: 12 }, (_, i) => ({ name: `tool_${i}` }));
    const reversed = Object.fromEntries(Object.entries(indexed(tools)).reverse());
    expect(definitions(exported(reversed))).toEqual(tools);
  });

  it("lets a native definitions key win, and still deletes the indexed keys", () => {
    const out = exported({
      [GEN_AI_TOOL_DEFINITIONS]: '[{"name":"native"}]',
      ...indexed(OPENAI_TOOLS),
    });
    expect(out).toEqual({ [GEN_AI_TOOL_DEFINITIONS]: '[{"name":"native"}]' });
  });

  it("leaves the whole family alone when any one schema does not parse", () => {
    // A partial array would be a silent loss; the family is content by prefix
    // already, so leaving it untouched lets nothing escape.
    const raw = {
      "llm.tools.0.tool.json_schema": JSON.stringify({ name: "ok" }),
      "llm.tools.1.tool.json_schema": "{not json",
    };
    expect(exported(raw)).toEqual(raw);
  });

  it("leaves the family alone when a schema is not a string", () => {
    const raw = {
      "llm.tools.0.tool.json_schema": JSON.stringify({ name: "ok" }),
      "llm.tools.1.tool.json_schema": 7,
    };
    expect(exported(raw)).toEqual(raw);
  });

  it("does not touch other keys under llm.tools", () => {
    const out = exported({
      ...indexed([{ name: "a" }]),
      "llm.tools.0.tool.something_else": "x",
    });
    expect(out["llm.tools.0.tool.something_else"]).toBe("x");
    expect(out["llm.tools.0.tool.json_schema"]).toBeUndefined();
    expect(definitions(out)).toEqual([{ name: "a" }]);
  });

  it("leaves a span without tools unchanged", () => {
    const raw = { "openinference.span.kind": "LLM", [GEN_AI_OPERATION_NAME]: "chat" };
    expect(exported(raw)).toEqual(raw);
    const bare: Record<string, never> = {};
    normalizeToolDefinitions(bare);
    expect(bare).toEqual({});
  });

  it("is never on the span at start: definitions are content, not identity", () => {
    const { atStart } = run({ "openinference.span.kind": "LLM", ...indexed(OPENAI_TOOLS) });
    expect(atStart[GEN_AI_TOOL_DEFINITIONS]).toBeUndefined();
  });
});

describe("gen_ai.tool.definitions from the request bag", () => {
  it("promotes bag tools when llm.tools is absent", () => {
    // litellm and langchain leave the request's tools inside the bag.
    const out = exported({
      "openinference.span.kind": "LLM",
      [LLM_INVOCATION_PARAMETERS]: JSON.stringify({
        model: "gpt-4o",
        tool_choice: "auto",
        tools: OPENAI_TOOLS,
      }),
    });
    expect(definitions(out)).toEqual(OPENAI_TOOLS);
    expect(out[GEN_AI_REQUEST_MODEL]).toBe("gpt-4o");
    expect(out[RIUS_REQUEST_TOOL_CHOICE]).toBe("auto");
    // Every member was promoted somewhere, so the bag goes rather than riding as "{}".
    expect(out[LLM_INVOCATION_PARAMETERS]).toBeUndefined();
  });

  it("promotes the legacy functions member", () => {
    const functions = [{ name: "get_weather", parameters: { type: "object" } }];
    const out = exported({
      [LLM_INVOCATION_PARAMETERS]: JSON.stringify({ functions, custom: 0.1 }),
    });
    expect(definitions(out)).toEqual(functions);
    expect(JSON.parse(String(out[LLM_INVOCATION_PARAMETERS]))).toEqual({ custom: 0.1 });
  });

  it("keeps tools then functions in one array, and drops a bag left empty", () => {
    const tools = [{ type: "function", function: { name: "a" } }];
    const functions = [{ name: "b" }];
    const out = exported({
      [LLM_INVOCATION_PARAMETERS]: JSON.stringify({ functions, tools }),
    });
    expect(definitions(out)).toEqual([...tools, ...functions]);
    // Nothing else was in the bag, so it goes rather than riding as "{}".
    expect(out[LLM_INVOCATION_PARAMETERS]).toBeUndefined();
  });

  it("drops a bag emptied by the table and this pass together", () => {
    // The table takes `model`, this pass takes `tools`: nothing is left.
    const out = exported({
      [LLM_INVOCATION_PARAMETERS]: JSON.stringify({ model: "gpt-4o", tools: [{ name: "a" }] }),
    });
    expect(out).toEqual({
      [GEN_AI_REQUEST_MODEL]: "gpt-4o",
      [GEN_AI_TOOL_DEFINITIONS]: '[{"name":"a"}]',
    });
  });

  it("leaves bag tools alone when llm.tools is present", () => {
    const bag = JSON.stringify({ tools: [{ name: "from-bag" }], tool_choice: "auto" });
    const out = exported({
      [LLM_INVOCATION_PARAMETERS]: bag,
      ...indexed([{ name: "from-llm-tools" }]),
    });
    expect(definitions(out)).toEqual([{ name: "from-llm-tools" }]);
    // tools stays in the bag; tool_choice is promoted out of it regardless.
    expect(out[LLM_INVOCATION_PARAMETERS]).toBe(JSON.stringify({ tools: [{ name: "from-bag" }] }));
    expect(out[RIUS_REQUEST_TOOL_CHOICE]).toBe("auto");
  });

  it("lets a native definitions key win over the bag, and the member still goes", () => {
    const out = exported({
      [GEN_AI_TOOL_DEFINITIONS]: '[{"name":"native"}]',
      [LLM_INVOCATION_PARAMETERS]: JSON.stringify({ tools: [{ name: "bag" }], custom: 1 }),
    });
    expect(out).toEqual({
      [GEN_AI_TOOL_DEFINITIONS]: '[{"name":"native"}]',
      [LLM_INVOCATION_PARAMETERS]: '{"custom":1}',
    });
  });

  it.each([
    ["unparseable", "{not json"],
    ["not an object", JSON.stringify(["tools"])],
    ["tools not a list", JSON.stringify({ tools: "not-a-list" })],
    ["one member not a list", JSON.stringify({ tools: [{ name: "a" }], functions: {} })],
    ["no tool members", JSON.stringify({ custom: 0.2 })],
  ])("leaves a bag with no usable tool list alone (%s)", (_label, bag) => {
    const out = exported({ [LLM_INVOCATION_PARAMETERS]: bag });
    expect(out).toEqual({ [LLM_INVOCATION_PARAMETERS]: bag });
  });
});

describe("gen_ai.tool.name from tool.name", () => {
  it("is mapped and the source deleted", () => {
    const out = exported(
      {
        "openinference.span.kind": "TOOL",
        "tool.name": "get_weather",
        "tool.description": "Weather for a city",
        "tool.parameters": '{"type":"object"}',
      },
      "get_weather",
    );
    expect(out).toEqual({
      "openinference.span.kind": "TOOL",
      [GEN_AI_OPERATION_NAME]: "execute_tool",
      [GEN_AI_TOOL_NAME]: "get_weather",
      // Content, already on the masking allowlist; not moved by this rule.
      "tool.description": "Weather for a city",
      "tool.parameters": '{"type":"object"}',
    });
  });

  it("lets a native tool name win, and the source still goes", () => {
    expect(exported({ [GEN_AI_TOOL_NAME]: "native", "tool.name": "other" })).toEqual({
      [GEN_AI_TOOL_NAME]: "native",
    });
  });

  it("does not borrow the span name when tool.name is absent", () => {
    // Deliberately NO fallback: a span name is not a tool name, and a wrong
    // tool name silently groups unrelated calls, which is worse than an
    // absent one. The native path removed exactly this fallback.
    const out = exported({ "openinference.span.kind": "TOOL" }, "get_weather");
    expect(out[GEN_AI_TOOL_NAME]).toBeUndefined();
  });

  it.each([[""], [42]])("maps a tool name that is not a name (%j) to nothing", (bad) => {
    expect(exported({ "tool.name": bad })).toEqual({ "tool.name": bad });
  });

  it("is identity: it is on the span at start, for the next processor", () => {
    const { atStart } = run({ "openinference.span.kind": "TOOL", "tool.name": "get_weather" });
    expect(atStart[GEN_AI_TOOL_NAME]).toBe("get_weather");
  });
});

describe("GenAI-shaped usage spellings", () => {
  // Each is its own rule AFTER the OpenInference rule for its target, not an
  // extra source on it: a rule converts only its first present source, so an
  // OpenInference count that won't parse would otherwise block a good one.
  const SPELLINGS = [
    [
      "gen_ai.usage.cache_creation.input_tokens",
      "llm.token_count.prompt_details.cache_write",
      GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS,
    ],
    [
      "gen_ai.usage.details.reasoning_tokens",
      "llm.token_count.completion_details.reasoning",
      GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
    ],
  ] as const;

  describe.each(SPELLINGS)("%s", (alternate, openinference, target) => {
    it("is mapped and deleted", () => {
      expect(exported({ [alternate]: 7 })).toEqual({ [target]: 7 });
    });

    it("lets native win, and the source still goes", () => {
      expect(exported({ [alternate]: 7, [target]: 99 })).toEqual({ [target]: 99 });
    });

    it("keeps 0 as a real count", () => {
      expect(exported({ [alternate]: 0 })).toEqual({ [target]: 0 });
    });

    it("parses a string count as a count", () => {
      expect(exported({ [alternate]: "12" })).toEqual({ [target]: 12 });
    });

    it("maps an unparseable count to nothing", () => {
      expect(exported({ [alternate]: "lots" })[target]).toBeUndefined();
    });

    it("yields to the OpenInference count when both parse", () => {
      expect(exported({ [openinference]: 5, [alternate]: 7 })).toEqual({ [target]: 5 });
    });

    it("is not blocked by an OpenInference count that won't parse", () => {
      expect(exported({ [openinference]: "lots", [alternate]: 7 })[target]).toBe(7);
    });
  });
});

// --- end to end through init() ----------------------------------------------

class Capture implements SpanExporter {
  readonly spans: ReadableSpan[] = [];
  export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
    // snapshot the bag: masking mutates in place
    for (const s of spans)
      this.spans.push({ ...s, attributes: { ...s.attributes } } as ReadableSpan);
    cb({ code: 0 });
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

let client: RiusClient | undefined;
afterEach(async () => {
  await client?.shutdown();
  client = undefined;
});

describe("through init()", () => {
  const SECRET = [{ name: "lookup", description: "SECRET-PROMPT-ENGINEERING" }];

  describe.each([
    ["llm.tools", { ...indexed(SECRET) }],
    ["bag", { [LLM_INVOCATION_PARAMETERS]: JSON.stringify({ tools: SECRET, seed: 7 }) }],
  ])("definitions promoted from %s", (route, source) => {
    it.each([true, false])("are content (captureContent: %s)", async (captureContent) => {
      const exporter = new Capture();
      client = init({ spanExporter: exporter, captureContent, heartbeat: false });
      trace
        .getTracer("third-party")
        .startSpan("ChatCompletion", {
          attributes: { "openinference.span.kind": "LLM", ...source },
        })
        .end();
      await client.flush();
      const [span] = exporter.spans;
      const out = span.attributes;
      expect(llmToolsKeys(out)).toEqual([]);
      if (captureContent) {
        expect(definitions(out)).toEqual(SECRET);
      } else {
        expect(out[GEN_AI_TOOL_DEFINITIONS]).toBeUndefined();
        expect(JSON.stringify(out)).not.toContain("SECRET");
      }
      // The knob the table promoted is a request parameter and survives.
      if (route === "bag") expect(out[GEN_AI_REQUEST_SEED]).toBe(7);
    });
  });

  it("puts a third-party tool name on the pending snapshot and the final span", async () => {
    const exporter = new Capture();
    client = init({ spanExporter: exporter, partialSpans: true, heartbeat: false });
    trace
      .getTracer("third-party")
      .startSpan("tool", {
        attributes: { "openinference.span.kind": "TOOL", "tool.name": "get_weather" },
      })
      .end();
    await client.flush();
    const pending = exporter.spans.filter((s) => s.attributes[RIUS_SPAN_PENDING] === true);
    const finals = exporter.spans.filter((s) => s.attributes[RIUS_SPAN_PENDING] !== true);
    expect(pending).toHaveLength(1);
    expect(finals).toHaveLength(1);
    expect(pending[0].attributes[GEN_AI_TOOL_NAME]).toBe("get_weather");
    expect(finals[0].attributes[GEN_AI_TOOL_NAME]).toBe("get_weather");
    expect(finals[0].attributes["tool.name"]).toBeUndefined();
  });

  it("leaves a third-party span's usage canonical", async () => {
    const exporter = new Capture();
    client = init({ spanExporter: exporter, heartbeat: false });
    trace
      .getTracer("third-party")
      .startSpan("chat gpt-4o", {
        attributes: {
          [GEN_AI_OPERATION_NAME]: "chat",
          "gen_ai.usage.input_tokens": 100,
          "gen_ai.usage.cache_creation.input_tokens": 40,
          "gen_ai.usage.details.reasoning_tokens": 0,
        },
      })
      .end();
    await client.flush();
    const out = exporter.spans[0].attributes;
    expect(out[GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS]).toBe(40);
    expect(out[GEN_AI_USAGE_REASONING_OUTPUT_TOKENS]).toBe(0);
    expect(out["gen_ai.usage.cache_creation.input_tokens"]).toBeUndefined();
    expect(out["gen_ai.usage.details.reasoning_tokens"]).toBeUndefined();
  });
});
