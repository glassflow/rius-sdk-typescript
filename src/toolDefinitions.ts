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
 *   function: {name, ...}}`: the nested object is lifted to the top level.
 * - Anthropic has no `type` (or `"custom"`) and names the schema
 *   `input_schema`; OpenAI's legacy `functions` entries have no `type`
 *   either. A definition with a string `name` and no `type` is a function.
 * - The schema is `parameters`; `input_schema` and the Vercel AI SDK's
 *   `inputSchema` are renamed to it, in place.
 *
 * Any other `type` is a provider's built-in tool (Anthropic's
 * `web_search_20250305`, OpenAI's `web_search`). Its fields are kept, and its
 * `type` is prefixed with the provider name, as the conventions recommend, so
 * it cannot collide with a type they define later:
 * `anthropic.web_search_20250305`. A type that already holds a dot is taken as
 * namespaced and left alone, which also keeps a second pass from stacking
 * prefixes. Nothing is invented: a built-in tool without a `name` stays
 * without one.
 *
 * Anything else (not an object, or no usable `type` or `name`) is kept as it
 * is: it is the caller's data, and there is no shape to vouch for.
 *
 * Ported from the Python SDK's `_tool_definitions.py`, rule for rule; both
 * must write the same JSON, key order included. Python's `dict.get` reads an
 * absent key and an explicit `None` alike, so an absent `type` and a `null`
 * one are the same here too.
 */

type Definition = Record<string, unknown>;

const FUNCTION = "function";
/** Schema spellings renamed to `parameters`, first match wins. */
const PARAMETER_SPELLINGS = ["input_schema", "inputSchema"] as const;
/** The Vercel AI SDK's provider tools, whose `id` is already `<provider>.<tool>`. */
const VERCEL_PROVIDER_TYPES = new Set(["provider-defined", "provider"]);

function isRecord(value: unknown): value is Definition {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The definitions in the conventions' shape; the caller's list is not mutated. */
export function semconvToolDefinitions(tools: unknown[], provider: string | undefined): unknown[] {
  return tools.map((tool) => semconvToolDefinition(tool, provider));
}

function semconvToolDefinition(tool: unknown, provider: string | undefined): unknown {
  if (!isRecord(tool)) return tool;
  const kind = tool.type ?? null;
  if (kind === FUNCTION) {
    const nested = tool[FUNCTION];
    if (!isRecord(nested)) return withParameters(tool);
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
  if (typeof kind !== "string") return tool;
  if (VERCEL_PROVIDER_TYPES.has(kind)) {
    const id = tool.id;
    return typeof id === "string" && id.includes(".") ? { ...tool, type: id } : tool;
  }
  if (provider && !kind.includes(".")) return { ...tool, type: `${provider}.${kind}` };
  return tool;
}

/** The tool with its schema under `parameters`, renamed where it stood. */
function withParameters(tool: Definition): Definition {
  if (Object.hasOwn(tool, "parameters")) return tool;
  for (const spelling of PARAMETER_SPELLINGS) {
    if (Object.hasOwn(tool, spelling)) {
      return Object.fromEntries(
        Object.entries(tool).map(([key, value]) => [key === spelling ? "parameters" : key, value]),
      );
    }
  }
  return tool;
}
