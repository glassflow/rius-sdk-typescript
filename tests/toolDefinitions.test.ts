/**
 * Tool definitions recorded in the GenAI conventions' shape.
 *
 * A `function` tool must be `{type: "function", name, description?,
 * parameters?}`: the conventions' schema no longer lets a `function` tool that
 * misses that shape fall back to the generic definition. A provider's built-in
 * tool keeps its own fields, with its `type` prefixed by the provider name
 * (`anthropic.web_search_20250305`). Ported from the Python SDK's
 * tests/test_tool_definitions.py, case for case.
 */
import { describe, expect, it } from "vitest";
import { semconvToolDefinitions } from "../src/toolDefinitions.js";

const PARAMETERS = { type: "object", properties: { city: { type: "string" } } };

describe("semconvToolDefinitions", () => {
  it("flattens OpenAI's nested function", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Weather for a city",
          parameters: PARAMETERS,
          strict: true,
        },
      },
    ];
    const out = semconvToolDefinitions(tools, "openai");
    expect(out).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Weather for a city",
        parameters: PARAMETERS,
        strict: true,
      },
    ]);
    // Key order is part of the wire contract: both SDKs write the same bytes.
    expect(JSON.stringify(out)).toBe(
      `[{"type":"function","name":"get_weather","description":"Weather for a city","parameters":${JSON.stringify(PARAMETERS)},"strict":true}]`,
    );
  });

  it("makes an Anthropic custom tool a function with parameters", () => {
    const tools = [{ name: "search_kb", description: "Search", input_schema: PARAMETERS }];
    const out = semconvToolDefinitions(tools, "anthropic");
    expect(JSON.stringify(out)).toBe(
      JSON.stringify([
        { type: "function", name: "search_kb", description: "Search", parameters: PARAMETERS },
      ]),
    );
  });

  it("makes an Anthropic explicit custom type a function", () => {
    const tools = [{ type: "custom", name: "search_kb", input_schema: PARAMETERS }];
    expect(semconvToolDefinitions(tools, "anthropic")).toEqual([
      { type: "function", name: "search_kb", parameters: PARAMETERS },
    ]);
  });

  it("makes a legacy OpenAI function without a type a function", () => {
    const tools = [{ name: "get_weather", parameters: PARAMETERS }];
    expect(semconvToolDefinitions(tools, undefined)).toEqual([
      { type: "function", name: "get_weather", parameters: PARAMETERS },
    ]);
  });

  it("names a flat function's camel-case inputSchema parameters", () => {
    // The Vercel AI SDK's function tool spells the schema inputSchema.
    const tools = [{ type: "function", name: "get_weather", inputSchema: PARAMETERS }];
    expect(semconvToolDefinitions(tools, "openai")).toEqual([
      { type: "function", name: "get_weather", parameters: PARAMETERS },
    ]);
  });

  it("leaves a conventions function tool unchanged", () => {
    const tool = { type: "function", name: "get_weather", parameters: PARAMETERS };
    expect(semconvToolDefinitions([tool], "openai")).toEqual([tool]);
  });

  it("prefixes a provider built-in tool's type", () => {
    const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];
    expect(semconvToolDefinitions(tools, "anthropic")).toEqual([
      { type: "anthropic.web_search_20250305", name: "web_search", max_uses: 5 },
    ]);
  });

  it("invents no name for a built-in tool without one", () => {
    expect(semconvToolDefinitions([{ type: "web_search" }], "openai")).toEqual([
      { type: "openai.web_search" },
    ]);
  });

  it("leaves a built-in tool unprefixed without a provider", () => {
    const tool = { type: "web_search_20250305", name: "web_search" };
    expect(semconvToolDefinitions([tool], undefined)).toEqual([tool]);
    expect(semconvToolDefinitions([tool], "")).toEqual([tool]);
  });

  it("does not prefix an already namespaced type again", () => {
    const tool = { type: "anthropic.web_search_20250305", name: "web_search" };
    expect(semconvToolDefinitions([tool], "anthropic")).toEqual([tool]);
    // A provider whose name has dots of its own does not stack a second prefix.
    expect(semconvToolDefinitions([tool], "azure.ai.openai")).toEqual([tool]);
  });

  it("gives a Vercel provider tool its namespaced id as type", () => {
    const tool = {
      type: "provider-defined",
      id: "anthropic.web_search_20250305",
      name: "web_search",
      args: {},
    };
    expect(semconvToolDefinitions([tool], "anthropic")).toEqual([
      { ...tool, type: "anthropic.web_search_20250305" },
    ]);
  });

  it.each([["plain"], [3], [null], [["x"]], [{ description: "no name or type" }]])(
    "keeps %j as it is",
    (tool) => {
      expect(semconvToolDefinitions([tool], "openai")).toEqual([tool]);
    },
  );

  it("normalizes twice the same as once", () => {
    const tools = [
      { type: "function", function: { name: "a", parameters: PARAMETERS } },
      { name: "b", input_schema: PARAMETERS },
      { type: "web_search_20250305", name: "web_search" },
    ];
    const once = semconvToolDefinitions(tools, "anthropic");
    expect(semconvToolDefinitions(once, "anthropic")).toEqual(once);
  });

  it("does not mutate the caller's list", () => {
    const tools = [{ name: "b", input_schema: PARAMETERS }, { type: "web_search" }];
    semconvToolDefinitions(tools, "openai");
    expect(tools).toEqual([{ name: "b", input_schema: PARAMETERS }, { type: "web_search" }]);
  });
});
