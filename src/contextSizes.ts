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
 * Wire shape (version 1), keys in this order, each present only when set:
 *   v: 1
 *   t: [[name | null, bytes], ...]              one per tool definition
 *   i: [[role, part, ...], ...]                 one per input message
 *   o: [[role, part, ...], ...]                 one per output message
 *   c: index into i of the last cache_control   omitted when none
 *   f: fold of the input messages older than the detail window
 * where a part is a bare integer (text bytes), ["c", tool, bytes] (tool call),
 * ["r", tool, bytes] (tool result) or ["m", type] (anything else, unsized),
 * and `tool` is the index into t, else the name, else null.
 *
 * Never throws: this runs on the user's hot path, so any unexpected shape
 * yields a best-effort entry (null tool, ["m", "unknown"], 0 bytes).
 */

/** Input messages that keep per-part detail; older ones fold into `f`. */
export const DETAIL_WINDOW = 50;
/** Cap on the attribute's own size; the detail window shrinks until it fits. */
export const MAX_SIZES_BYTES = 8192;
export const SIZES_VERSION = 1;

type ToolRef = number | string | null;
type PartEntry = number | ["c" | "r", ToolRef, number] | ["m", string];
type MessageEntry = [string, ...PartEntry[]];
type ToolEntry = [string | null, number];

interface Fold {
  n: number;
  s?: number;
  u?: number;
  a?: number;
  t?: [ToolRef, number][];
  m?: number;
}

interface Sizes {
  v: number;
  t?: ToolEntry[];
  i?: MessageEntry[];
  o?: MessageEntry[];
  c?: number;
  f?: Fold;
}

const ROLE_CODES: Record<string, string> = {
  system: "s",
  developer: "s",
  user: "u",
  assistant: "a",
  tool: "t",
  function: "t",
};

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

function toolName(tool: unknown): string | null {
  if (!isRecord(tool)) return null;
  const fn = tool.function;
  if (isRecord(fn) && typeof fn.name === "string") return fn.name;
  return typeof tool.name === "string" ? tool.name : null;
}

function roleCode(role: unknown): string {
  if (typeof role === "string") return ROLE_CODES[role] ?? role;
  return String(role);
}

function partsOf(message: unknown): unknown[] {
  if (!isRecord(message)) return [];
  return Array.isArray(message.parts) ? message.parts : [];
}

/** A distinct map key per tool reference: the index 0 and the name "0" differ. */
function refKey(ref: ToolRef): string {
  return `${typeof ref}:${String(ref)}`;
}

class Context {
  private readonly toolIndex = new Map<string, number>();
  private readonly callNames = new Map<unknown, unknown>();

  constructor(tools: unknown[] | undefined, messageLists: unknown[][]) {
    (tools ?? []).forEach((tool, index) => {
      const name = toolName(tool);
      if (name !== null && !this.toolIndex.has(name)) this.toolIndex.set(name, index);
    });
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

  toolRef(name: unknown): ToolRef {
    if (typeof name !== "string") return null;
    return this.toolIndex.get(name) ?? name;
  }

  partEntry(part: unknown): PartEntry {
    if (!isRecord(part)) return ["m", "unknown"];
    switch (part.type) {
      case "text": {
        const content = part.content ?? null;
        return typeof content === "string" ? Buffer.byteLength(content) : canonicalBytes(content);
      }
      case "tool_call":
        return ["c", this.toolRef(part.name), canonicalBytes(part)];
      case "tool_call_response": {
        const name = typeof part.id === "string" ? this.callNames.get(part.id) : undefined;
        return ["r", this.toolRef(name), canonicalBytes(part)];
      }
      default:
        return ["m", typeof part.type === "string" ? part.type : "unknown"];
    }
  }

  messageEntry(message: unknown): MessageEntry {
    const role = isRecord(message) ? message.role : undefined;
    return [roleCode(role), ...partsOf(message).map((part) => this.partEntry(part))];
  }
}

function hasCacheMarker(message: unknown): boolean {
  return partsOf(message).some(
    (part) => isRecord(part) && part.cache_control !== undefined && part.cache_control !== null,
  );
}

/** Aggregate the message entries older than the detail window. */
function fold(entries: MessageEntry[]): Fold {
  let s = 0;
  let u = 0;
  let a = 0;
  let m = 0;
  const tools = new Map<string, [ToolRef, number]>();
  for (const [role, ...parts] of entries) {
    for (const part of parts) {
      if (typeof part === "number") {
        if (role === "s") s += part;
        else if (role === "a") a += part;
        else u += part; // "u", "t" and literal roles all count as user-side text
      } else if (part[0] === "m") {
        m += 1;
      } else {
        const [, ref, bytes] = part;
        const key = refKey(ref);
        const entry = tools.get(key);
        if (entry) entry[1] += bytes;
        else tools.set(key, [ref, bytes]);
      }
    }
  }
  const result: Fold = { n: entries.length };
  if (s > 0) result.s = s;
  if (u > 0) result.u = u;
  if (a > 0) result.a = a;
  if (tools.size > 0) result.t = [...tools.values()];
  if (m > 0) result.m = m;
  return result;
}

function assemble(
  toolEntries: ToolEntry[] | undefined,
  inputEntries: MessageEntry[] | undefined,
  outputEntries: MessageEntry[] | undefined,
  cacheIndex: number | undefined,
  window: number,
): Sizes {
  const sizes: Sizes = { v: SIZES_VERSION };
  if (toolEntries !== undefined) sizes.t = toolEntries;
  let folded: Fold | undefined;
  if (inputEntries !== undefined) {
    const excess = inputEntries.length - window;
    if (excess > 0) {
      folded = fold(inputEntries.slice(0, excess));
      sizes.i = inputEntries.slice(excess);
    } else {
      sizes.i = inputEntries;
    }
  }
  if (outputEntries !== undefined) sizes.o = outputEntries;
  if (cacheIndex !== undefined) sizes.c = cacheIndex;
  if (folded !== undefined) sizes.f = folded;
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
    const context = new Context(toolList, [inputs ?? [], outputs ?? []]);

    const toolEntries = toolList?.map((tool): ToolEntry => [toolName(tool), canonicalBytes(tool)]);
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
    return JSON.stringify({ v: SIZES_VERSION });
  }
}
