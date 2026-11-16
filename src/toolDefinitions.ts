/**
 * Tool definitions in the GenAI conventions' shape (`gen_ai.tool.definitions`).
 *
 * The conventions define one tool type, `function`:
 * `{type: "function", name, description?, parameters?}`, and a definition
 * whose `type` is `function` must match that shape: it can no longer pass as
 * the generic definition. Providers spell function tools their own way, so
 * each is rewritten:
 *
 * - OpenAI Chat Completions nests the function, `{type: "function",
 *   function: {name, ...}}`: the nested object is lifted to the top level,
 *   unless the top level already has a string `name` (then the tool is already
 *   flat, and `function` is one of its fields).
 * - Anthropic has no `type` (or `"custom"`) and names the schema
 *   `input_schema`; OpenAI's legacy `functions` entries have no `type`
 *   either. A definition with a string `name` and no `type` is a function.
 * - The schema is `parameters`; `input_schema` and the Vercel AI SDK's
 *   `inputSchema` are renamed to it, in place.
 * - Bedrock Converse wraps the function, `{toolSpec: {name, description,
 *   inputSchema: {json: schema}}}`: it is unwrapped, and `json` becomes
 *   `parameters`.
 * - A Gemini tool holds a list of declarations, `{function_declarations:
 *   [...]}` (`functionDeclarations` in camel case; every spelling holding a
 *   list expands, snake case first). Each declaration with a string `name`
 *   becomes its own function tool, its schema taken from `parameters` or,
 *   failing that, `parametersJsonSchema` / `parameters_json_schema` /
 *   `input_schema` / `inputSchema`. A declaration without a name, and whatever
 *   else the Gemini tool holds (a built-in such as `google_search`), is its own
 *   entry, rewritten by the rules for a single tool.
 * - A `null` `parameters` counts as no schema, so a schema under another
 *   spelling still takes its place (a Python `model_dump()` of a Gemini
 *   declaration holds both).
 *
 * Any other `type` is a provider's built-in tool (Anthropic's
 * `web_search_20250305`, OpenAI's `web_search`). Its fields are kept, and its
 * `type` is prefixed with the provider name, as the conventions recommend, so
 * it cannot collide with a type they define later:
 * `anthropic.web_search_20250305`. An empty `type` is no type, and gets no
 * prefix. A type that already holds a dot is taken as
 * namespaced and left alone, which also keeps a second pass from stacking
 * prefixes. Nothing is invented: a built-in tool without a `name` (OpenAI's
 * `web_search`, Gemini's `google_search`) stays without one. Tool names are
 * read as the tools the model was offered, and an invented name would be a
 * tool offered and never called by that name.
 *
 * An MCP tool (OpenAI Responses' `type: "mcp"`) loses its `headers`: they are
 * the requests' headers to the MCP server, and can carry an `Authorization`
 * credential, which never belongs in telemetry.
 *
 * Anything else (not an object, or no usable `type` or `name`) is kept as it
 * is: it is the caller's data, and there is no shape to vouch for.
 *
 * Every rule's output is a fixed point: rewriting a rewritten list changes
 * nothing. The sink rewrites what an SDK exported, so this keeps one tool in
 * one shape.
 *
 * Ported from the Python SDK's `_tool_definitions.py`, rule for rule, as is the
 * sink's; all three write the same canonical JSON, key order included, and
 * rius-semconv's `sdk_cases/tool_definitions.json` holds them to it. Number
 * formatting is each language's own (Python writes `1.0`, TypeScript `1`), and
 * JavaScript orders integer-like keys first. Python's `dict.get` reads an
 * absent key and an explicit `None` alike, so an absent `type` and a `null`
 * one are the same here too.
 */

type Definition = Record<string, unknown>;

const FUNCTION = "function";
/** Schema spellings renamed to `parameters`, first match wins. */
const PARAMETER_SPELLINGS = ["input_schema", "inputSchema"] as const;
/** Gemini's own schema spellings, renamed to `parameters` on a declaration. */
const GEMINI_PARAMETER_SPELLINGS = ["parametersJsonSchema", "parameters_json_schema"] as const;
/** A Gemini tool's list of function declarations, snake and camel case. */
const GEMINI_DECLARATIONS = ["function_declarations", "functionDeclarations"] as const;
/** The Vercel AI SDK's provider tools, whose `id` is already `<provider>.<tool>`. */
const VERCEL_PROVIDER_TYPES = new Set(["provider-defined", "provider"]);
/** OpenAI Responses' MCP tool, as given and once namespaced; its `headers` go. */
const MCP_TYPES = new Set(["mcp", "openai.mcp"]);

function isRecord(value: unknown): value is Definition {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The definitions in the conventions' shape; the caller's list is not mutated.
 * A Gemini tool expands to one entry per declaration, so the result can be
 * longer than `tools`.
 */
export function semconvToolDefinitions(tools: unknown[], provider: string | undefined): unknown[] {
  const definitions: unknown[] = [];
  for (const tool of tools) {
    const expanded = geminiDeclarations(tool, provider);
    if (expanded === undefined) definitions.push(semconvToolDefinition(tool, provider));
    else definitions.push(...expanded);
  }
  return definitions;
}

/** A Gemini tool as one entry per declaration, then the rest; undefined if not one. */
function geminiDeclarations(tool: unknown, provider: string | undefined): unknown[] | undefined {
  if (!isRecord(tool) || (tool.type ?? null) !== null) return undefined;
  const keys = GEMINI_DECLARATIONS.filter(
    (name) => Object.hasOwn(tool, name) && Array.isArray(tool[name]),
  );
  if (keys.length === 0) return undefined;
  const entries: unknown[] = [];
  for (const key of keys) {
    for (const declaration of tool[key] as unknown[]) {
      if (isRecord(declaration) && typeof declaration.name === "string") {
        entries.push(geminiDeclaration(declaration));
      } else {
        entries.push(...semconvToolDefinitions([declaration], provider));
      }
    }
  }
  const rest = Object.entries(tool).filter(([name]) => !(keys as string[]).includes(name));
  if (rest.length > 0)
    entries.push(...semconvToolDefinitions([Object.fromEntries(rest)], provider));
  return entries;
}

function geminiDeclaration(declaration: Definition): Definition {
  const rest = Object.entries(declaration).filter(([key]) => key !== "type");
  return withParameters(Object.fromEntries([["type", FUNCTION], ...rest]), [
    ...GEMINI_PARAMETER_SPELLINGS,
    ...PARAMETER_SPELLINGS,
  ]);
}

function semconvToolDefinition(tool: unknown, provider: string | undefined): unknown {
  if (!isRecord(tool)) return tool;
  const kind = tool.type ?? null;
  if (kind === FUNCTION) {
    const nested = tool[FUNCTION];
    if (!isRecord(nested) || typeof tool.name === "string") return withParameters(tool);
    // Object.fromEntries defines own properties, so a key such as `__proto__`
    // in the caller's object stays a key instead of setting a prototype.
    const lifted = Object.entries(nested).filter(([key]) => key !== "type");
    const taken = new Set(lifted.map(([key]) => key));
    const rest = Object.entries(tool).filter(
      ([key]) => key !== "type" && key !== FUNCTION && !taken.has(key),
    );
    return withParameters(Object.fromEntries([["type", FUNCTION], ...lifted, ...rest]));
  }
  if (
    typeof tool.name === "string" &&
    (kind === null || (kind === "custom" && Object.hasOwn(tool, "input_schema")))
  ) {
    const rest = Object.entries(tool).filter(([key]) => key !== "type");
    return withParameters(Object.fromEntries([["type", FUNCTION], ...rest]));
  }
  const spec = tool.toolSpec;
  if (kind === null && isRecord(spec) && typeof spec.name === "string") {
    return bedrockTool(tool, spec);
  }
  if (typeof kind !== "string" || kind === "") return tool;
  return builtInTool(withoutCredentials(tool, kind), kind, provider);
}

/** A provider's built-in tool, its type namespaced. */
function builtInTool(tool: Definition, kind: string, provider: string | undefined): Definition {
  if (VERCEL_PROVIDER_TYPES.has(kind)) {
    const id = tool.id;
    return typeof id === "string" && id.includes(".") ? { ...tool, type: id } : tool;
  }
  if (provider && !kind.includes(".")) return { ...tool, type: `${provider}.${kind}` };
  return tool;
}

/** An MCP tool without its `headers`, which can carry a credential. */
function withoutCredentials(tool: Definition, kind: string): Definition {
  if (!MCP_TYPES.has(kind) || !Object.hasOwn(tool, "headers")) return tool;
  return Object.fromEntries(Object.entries(tool).filter(([key]) => key !== "headers"));
}

/** Bedrock's `toolSpec` lifted to a function tool, `inputSchema.json` as parameters. */
function bedrockTool(tool: Definition, spec: Definition): Definition {
  const lifted: [string, unknown][] = [];
  for (const [key, value] of Object.entries(spec)) {
    if (key === "type") continue;
    if (key === "inputSchema" && isRecord(value) && Object.hasOwn(value, "json")) {
      lifted.push(["parameters", value.json]);
    } else {
      lifted.push([key, value]);
    }
  }
  // Python's dict assignment keeps a key's first position and its last value.
  const flat = new Map<string, unknown>([["type", FUNCTION]]);
  for (const [key, value] of lifted) flat.set(key, value);
  for (const [key, value] of Object.entries(tool)) {
    if (key !== "type" && key !== "toolSpec" && !flat.has(key)) flat.set(key, value);
  }
  return withParameters(Object.fromEntries(flat));
}

/**
 * The tool with its schema under `parameters`, renamed where it stood. A
 * `null` `parameters` is no schema: when another spelling holds one, the null
 * goes and that spelling is renamed. Python's `dict.get` reads an absent key
 * and an explicit `None` alike, so `undefined` and `null` are the same here.
 */
function withParameters(
  tool: Definition,
  spellings: readonly string[] = PARAMETER_SPELLINGS,
): Definition {
  if ((tool.parameters ?? null) !== null) return tool;
  for (const spelling of spellings) {
    if (Object.hasOwn(tool, spelling)) {
      return Object.fromEntries(
        Object.entries(tool)
          .filter(([key]) => key !== "parameters")
          .map(([key, value]) => [key === spelling ? "parameters" : key, value]),
      );
    }
  }
  return tool;
}
