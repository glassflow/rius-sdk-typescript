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

  // JSON.stringify compares key order too, which must match the Python SDK's.
  const json = (value: unknown) => JSON.stringify(value);

  it("unwraps Bedrock's toolSpec into a function with its json schema", () => {
    const tools = [
      {
        toolSpec: {
          name: "get_weather",
          description: "Weather for a city",
          inputSchema: { json: PARAMETERS },
        },
      },
    ];
    expect(json(semconvToolDefinitions(tools, "aws.bedrock"))).toBe(
      json([
        {
          type: "function",
          name: "get_weather",
          description: "Weather for a city",
          parameters: PARAMETERS,
        },
      ]),
    );
  });

  it("keeps a Bedrock toolSpec without a name, and a cache point", () => {
    const nameless = { toolSpec: { inputSchema: { json: PARAMETERS } } };
    const cachePoint = { cachePoint: { type: "default" } };
    expect(semconvToolDefinitions([nameless, cachePoint], "aws.bedrock")).toEqual([
      nameless,
      cachePoint,
    ]);
  });

  it.each([
    ["function_declarations", "parameters"],
    ["functionDeclarations", "parametersJsonSchema"],
  ])("expands Gemini %s into one function tool per declaration (%s)", (container, schema) => {
    const tools = [
      {
        [container]: [
          { name: "get_weather", description: "Weather", [schema]: PARAMETERS },
          { name: "get_time" },
        ],
      },
      { name: "lookup", input_schema: PARAMETERS },
    ];
    expect(json(semconvToolDefinitions(tools, "gcp.gemini"))).toBe(
      json([
        { type: "function", name: "get_weather", description: "Weather", parameters: PARAMETERS },
        { type: "function", name: "get_time" },
        { type: "function", name: "lookup", parameters: PARAMETERS },
      ]),
    );
  });

  it("names Gemini's snake-case json schema parameters", () => {
    const tools = [{ function_declarations: [{ name: "f", parameters_json_schema: PARAMETERS }] }];
    expect(json(semconvToolDefinitions(tools, "gcp.gemini"))).toBe(
      json([{ type: "function", name: "f", parameters: PARAMETERS }]),
    );
  });

  it("keeps Gemini built-ins beside the declarations without a name", () => {
    // A built-in has no name of its own: inventing one would record a tool
    // that is offered but never called by that name.
    const tools = [
      { function_declarations: [{ name: "f" }], google_search: {} },
      { code_execution: {} },
    ];
    expect(json(semconvToolDefinitions(tools, "gcp.gemini"))).toBe(
      json([{ type: "function", name: "f" }, { google_search: {} }, { code_execution: {} }]),
    );
  });

  it("keeps a Gemini declaration without a name as given", () => {
    const tools = [{ functionDeclarations: [{ description: "no name" }, "odd"] }];
    expect(semconvToolDefinitions(tools, "gcp.gemini")).toEqual([
      { description: "no name" },
      "odd",
    ]);
  });

  it("keeps a Gemini container that is not a list", () => {
    const tool = { function_declarations: { name: "f" } };
    expect(semconvToolDefinitions([tool], "gcp.gemini")).toEqual([tool]);
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
      { toolSpec: { name: "c", inputSchema: { json: PARAMETERS } } },
      { functionDeclarations: [{ name: "d", parametersJsonSchema: PARAMETERS }] },
      { function_declarations: [{ name: "e" }], google_search: {} },
    ];
    const once = semconvToolDefinitions(tools, "anthropic");
    expect(semconvToolDefinitions(once, "anthropic")).toEqual(once);
  });

  it("expands every declarations spelling that holds a list", () => {
    const tools = [
      { function_declarations: [{ name: "a" }], functionDeclarations: [{ name: "b" }] },
    ];
    expect(semconvToolDefinitions(tools, "gcp.gemini")).toEqual([
      { type: "function", name: "a" },
      { type: "function", name: "b" },
    ]);
  });

  it("keeps a declarations spelling that is not a list in the rest", () => {
    const tools = [{ function_declarations: [{ name: "a" }], functionDeclarations: "odd" }];
    expect(semconvToolDefinitions(tools, "gcp.gemini")).toEqual([
      { type: "function", name: "a" },
      { functionDeclarations: "odd" },
    ]);
  });

  it.each(["input_schema", "inputSchema"])(
    "names a declaration's %s schema parameters",
    (spelling) => {
      const tools = [{ function_declarations: [{ name: "a", [spelling]: PARAMETERS }] }];
      expect(semconvToolDefinitions(tools, "gcp.gemini")).toEqual([
        { type: "function", name: "a", parameters: PARAMETERS },
      ]);
    },
  );

  it("rewrites a nameless declaration by the single-tool rule", () => {
    const tools = [{ function_declarations: [{ type: "web_search" }] }];
    expect(semconvToolDefinitions(tools, "gcp.gemini")).toEqual([
      { type: "gcp.gemini.web_search" },
    ]);
  });

  it("rewrites the rest of a Gemini tool by the single-tool rule", () => {
    const tools = [{ function_declarations: [{ name: "a" }], name: "x" }];
    expect(semconvToolDefinitions(tools, "gcp.gemini")).toEqual([
      { type: "function", name: "a" },
      { type: "function", name: "x" },
    ]);
  });

  it("does not lift a nested function over a top-level name", () => {
    const named = { name: "x", function: { name: "y" } };
    const typed = { type: "function", name: "x", function: { name: "y" } };
    expect(semconvToolDefinitions([named, typed], "openai")).toEqual([
      { type: "function", name: "x", function: { name: "y" } },
      typed,
    ]);
  });

  it("lets a null parameters give way to a schema spelling", () => {
    // A Python model_dump() of a google-genai FunctionDeclaration, as JSON.
    const tools = [
      {
        function_declarations: [
          { name: "f", parameters: null, parameters_json_schema: PARAMETERS },
        ],
      },
      { name: "g", parameters: null, input_schema: PARAMETERS },
    ];
    expect(semconvToolDefinitions(tools, "gcp.gemini")).toEqual([
      { type: "function", name: "f", parameters: PARAMETERS },
      { type: "function", name: "g", parameters: PARAMETERS },
    ]);
  });

  it("keeps a null parameters without another schema", () => {
    const tool = { type: "function", name: "f", parameters: null };
    expect(semconvToolDefinitions([tool], "openai")).toEqual([tool]);
  });

  it("gives an empty type no provider prefix", () => {
    const tool = { type: "", size: 1 };
    expect(semconvToolDefinitions([tool], "openai")).toEqual([tool]);
  });

  it("drops an MCP tool's headers", () => {
    // OpenAI Responses' MCP tool carries the server's request headers, which
    // can hold an Authorization credential.
    const tool = {
      type: "mcp",
      server_label: "docs",
      server_url: "https://mcp.example.com",
      headers: { Authorization: "Bearer secret" },
      require_approval: "never",
    };
    expect(semconvToolDefinitions([tool], "openai")).toEqual([
      {
        type: "openai.mcp",
        server_label: "docs",
        server_url: "https://mcp.example.com",
        require_approval: "never",
      },
    ]);
    const namespaced = { type: "openai.mcp", server_label: "docs", headers: { "X-Key": "k" } };
    expect(semconvToolDefinitions([namespaced], undefined)).toEqual([
      { type: "openai.mcp", server_label: "docs" },
    ]);
    expect(semconvToolDefinitions([{ type: "mcp", headers: {} }], undefined)).toEqual([
      { type: "mcp" },
    ]);
  });

  it("does not mutate the caller's list", () => {
    const tools = [{ name: "b", input_schema: PARAMETERS }, { type: "web_search" }];
    semconvToolDefinitions(tools, "openai");
    expect(tools).toEqual([{ name: "b", input_schema: PARAMETERS }, { type: "web_search" }]);
  });
});
