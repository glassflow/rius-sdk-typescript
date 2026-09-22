/**
 * `rius.context.sizes`: the UTF-8 byte size of every part of the context a
 * generation span serialized — tool definitions, each input and output
 * message part, the cache-marker position — as one compact JSON string.
 *
 * The backend uses it to attribute `gen_ai.usage.input_tokens` across parts,
 * so it is computed from the NORMALIZED messages before any truncation and is
 * never masked or stripped: it must stay correct when the content attributes
 * were cut at the attribute cap, dropped by `captureContent: false` or
 * rewritten by a mask. The Python SDK implements the same wire format; the
 * parity fixture under tests/fixtures asserts both produce identical bytes.
 *
 * Wire shape (version 1). Top-level keys in this order, each present only
 * when set; compact JSON (no whitespace), readable through its keys:
 *   version:          1
 *   tool_definitions: [{name: string | null, bytes}, ...]     caller order
 *   input_messages:   [{role, parts: [...]}, ...]             one per message
 *   output_messages:  [{role, parts: [...]}, ...]
 *   cache_marker:     index into the ORIGINAL input list of the last message
 *                     with a non-null `cache_control` part; omitted when none
 *   folded:           aggregate of the input messages older than the detail
 *                     window (see below); omitted when nothing folded
 * `role` is the message's literal role string. A part is one of
 *   {type: "text", bytes}                       raw UTF-8 bytes of the content
 *   {type: "tool_call", tool, bytes}            canonical bytes of the part
 *   {type: "tool_call_response", tool, bytes}   canonical bytes of the part
 *   {type: <other type or "unknown">}           media and unknown parts, unsized
 * where `tool` is the tool NAME (a tool result's name is resolved through its
 * call id) or null when unknown.
 *
 * Folding: only the last DETAIL_WINDOW input messages keep per-part detail;
 * older ones collapse into `folded`:
 *   {messages, system_bytes, user_bytes, assistant_bytes,
 *    tools: [{tool, bytes}, ...], multimodal_parts}
 * (`messages` always present, the rest only when non-zero). Text bytes bucket
 * by role: system/developer → system_bytes, assistant → assistant_bytes,
 * every other role → user_bytes; tool bytes sum per tool name (null its own
 * bucket) in first-seen order. While the compact JSON exceeds MAX_SIZES_BYTES
 * the window halves and the fold is redone; the string itself is never cut.
 *
 * Never throws: this runs on the user's hot path, so any unexpected shape
 * yields a best-effort entry (null tool, {type: "unknown"}, 0 bytes).
 */

/** Input messages that keep per-part detail; older ones fold into `folded`. */
export const DETAIL_WINDOW = 50;
/** Cap on the attribute's own size; the detail window shrinks until it fits. */
export const MAX_SIZES_BYTES = 8192;
export const SIZES_VERSION = 1;

type ToolName = string | null;

type PartEntry =
  | { type: "text"; bytes: number }
  | { type: "tool_call" | "tool_call_response"; tool: ToolName; bytes: number }
  | { type: string };

interface MessageEntry {
  role: string;
  parts: PartEntry[];
}

interface ToolEntry {
  name: ToolName;
  bytes: number;
}

interface ToolSum {
  tool: ToolName;
  bytes: number;
}

interface Fold {
  messages: number;
  system_bytes?: number;
  user_bytes?: number;
  assistant_bytes?: number;
  tools?: ToolSum[];
  multimodal_parts?: number;
}

interface Sizes {
  version: number;
  tool_definitions?: ToolEntry[];
  input_messages?: MessageEntry[];
  output_messages?: MessageEntry[];
  cache_marker?: number;
  folded?: Fold;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** UTF-8 bytes of the value's compact JSON; 0 when it cannot be rendered. */
function canonicalBytes(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : Buffer.byteLength(text);
  } catch {
    return 0;
  }
}

function toolName(tool: unknown): ToolName {
  if (!isRecord(tool)) return null;
  const fn = tool.function;
  if (isRecord(fn) && typeof fn.name === "string") return fn.name;
  return typeof tool.name === "string" ? tool.name : null;
}

function asToolName(name: unknown): ToolName {
  return typeof name === "string" ? name : null;
}

function partsOf(message: unknown): unknown[] {
  if (!isRecord(message)) return [];
  return Array.isArray(message.parts) ? message.parts : [];
}

/** A distinct bucket key per tool name; null is its own bucket. */
function toolKey(name: ToolName): string {
  return name === null ? "\0null" : `name:${name}`;
}

class Context {
  private readonly callNames = new Map<string, unknown>();

  constructor(messageLists: unknown[][]) {
    // tool_call ids → names over every message, inputs first, so a result can
    // be attributed to its tool even when the call sits in another list.
    for (const messages of messageLists) {
      for (const message of messages) {
        for (const part of partsOf(message)) {
          // First call with an id wins, as in the Python SDK: the two must
          // resolve a duplicated id to the same tool.
          if (
            isRecord(part) &&
            part.type === "tool_call" &&
            typeof part.id === "string" &&
            !this.callNames.has(part.id)
          ) {
            this.callNames.set(part.id, part.name);
          }
        }
      }
    }
  }

  partEntry(part: unknown): PartEntry {
    if (!isRecord(part)) return { type: "unknown" };
    switch (part.type) {
      case "text": {
        const content = part.content ?? null;
        const bytes =
          typeof content === "string" ? Buffer.byteLength(content) : canonicalBytes(content);
        return { type: "text", bytes };
      }
      case "tool_call":
        return { type: "tool_call", tool: asToolName(part.name), bytes: canonicalBytes(part) };
      case "tool_call_response": {
        const name = typeof part.id === "string" ? this.callNames.get(part.id) : undefined;
        return { type: "tool_call_response", tool: asToolName(name), bytes: canonicalBytes(part) };
      }
      default:
        return { type: typeof part.type === "string" ? part.type : "unknown" };
    }
  }

  messageEntry(message: unknown): MessageEntry {
    const role = isRecord(message) ? message.role : undefined;
    return {
      role: typeof role === "string" ? role : String(role),
      parts: partsOf(message).map((part) => this.partEntry(part)),
    };
  }
}

function hasCacheMarker(message: unknown): boolean {
  return partsOf(message).some(
    (part) => isRecord(part) && part.cache_control !== undefined && part.cache_control !== null,
  );
}

/** Aggregate the message entries older than the detail window. */
function fold(entries: MessageEntry[]): Fold {
  let system = 0;
  let user = 0;
  let assistant = 0;
  let multimodal = 0;
  const tools = new Map<string, ToolSum>();
  for (const { role, parts } of entries) {
    for (const part of parts) {
      if (!("bytes" in part)) {
        multimodal += 1;
      } else if (part.type === "text") {
        if (role === "system" || role === "developer") system += part.bytes;
        else if (role === "assistant") assistant += part.bytes;
        else user += part.bytes; // user, tool, function and literal roles: user-side text
      } else if ("tool" in part) {
        const key = toolKey(part.tool);
        const sum = tools.get(key);
        if (sum) sum.bytes += part.bytes;
        else tools.set(key, { tool: part.tool, bytes: part.bytes });
      }
    }
  }
  const result: Fold = { messages: entries.length };
  if (system > 0) result.system_bytes = system;
  if (user > 0) result.user_bytes = user;
  if (assistant > 0) result.assistant_bytes = assistant;
  if (tools.size > 0) result.tools = [...tools.values()];
  if (multimodal > 0) result.multimodal_parts = multimodal;
  return result;
}

function assemble(
  toolEntries: ToolEntry[] | undefined,
  inputEntries: MessageEntry[] | undefined,
  outputEntries: MessageEntry[] | undefined,
  cacheIndex: number | undefined,
  window: number,
): Sizes {
  const sizes: Sizes = { version: SIZES_VERSION };
  if (toolEntries !== undefined) sizes.tool_definitions = toolEntries;
  let folded: Fold | undefined;
  if (inputEntries !== undefined) {
    const excess = inputEntries.length - window;
    if (excess > 0) {
      folded = fold(inputEntries.slice(0, excess));
      sizes.input_messages = inputEntries.slice(excess);
    } else {
      sizes.input_messages = inputEntries;
    }
  }
  if (outputEntries !== undefined) sizes.output_messages = outputEntries;
  if (cacheIndex !== undefined) sizes.cache_marker = cacheIndex;
  if (folded !== undefined) sizes.folded = folded;
  return sizes;
}

/** Lists only; anything else counts as "not set", as in the Python SDK. */
function asList(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * The `rius.context.sizes` value for a generation. `inputMessages` and
 * `outputMessages` are NORMALIZED message lists (`{role, parts}` as
 * `normalizeMessages` returns them); `tools` is the raw tool-definition list.
 * Any argument may be undefined: its key is then absent from the result.
 */
export function contextSizes(
  tools: unknown[] | undefined,
  inputMessages: unknown[] | undefined,
  outputMessages: unknown[] | undefined,
): string {
  try {
    const toolList = asList(tools);
    const inputs = asList(inputMessages);
    const outputs = asList(outputMessages);
    const context = new Context([inputs ?? [], outputs ?? []]);

    const toolEntries = toolList?.map(
      (tool): ToolEntry => ({ name: toolName(tool), bytes: canonicalBytes(tool) }),
    );
    const inputEntries = inputs?.map((message) => context.messageEntry(message));
    const outputEntries = outputs?.map((message) => context.messageEntry(message));
    let cacheIndex: number | undefined;
    inputs?.forEach((message, index) => {
      if (hasCacheMarker(message)) cacheIndex = index;
    });

    // Shrink the detail window until the attribute fits its own cap. The
    // string itself is never cut: a truncated JSON attribute is worthless.
    let window = DETAIL_WINDOW;
    for (;;) {
      const text = JSON.stringify(
        assemble(toolEntries, inputEntries, outputEntries, cacheIndex, window),
      );
      if (window === 0 || Buffer.byteLength(text) <= MAX_SIZES_BYTES) return text;
      window = Math.floor(window / 2);
    }
  } catch {
    return JSON.stringify({ version: SIZES_VERSION });
  }
}
