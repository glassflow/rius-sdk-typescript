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
 *   {type: "text", bytes}                       UTF-8 bytes of the content's prose:
 *                                               a media token in it (a data URL,
 *                                               keyed base64, a Buffer) is not
 *                                               prose, and follows the text as
 *                                               a blob entry of its own
 *   {type: "tool_call", tool, bytes}            canonical bytes of the part
 *   {type: "tool_call_response", tool, bytes}   canonical bytes of the part
 *   {type: "blob" | "uri" | "file", modality, byte_size?}
 *                                               a media part: its modality and,
 *                                               when known, the media's own size
 *   {type: <other type or "unknown">}           other parts, unsized
 * where `tool` is the tool NAME (a tool result's name is resolved through its
 * call id) or null when unknown. A media entry never carries `bytes`: its
 * size is the media's, not that of any content, which a blob does not carry.
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

import { type MediaToken, modalityOf, splitMedia, type TextSplit } from "./mediaParts.js";

/** Input messages that keep per-part detail; older ones fold into `folded`. */
export const DETAIL_WINDOW = 50;
/** Cap on the attribute's own size; the detail window shrinks until it fits. */
export const MAX_SIZES_BYTES = 8192;
export const SIZES_VERSION = 1;

type ToolName = string | null;

type PartEntry =
  | { type: "text"; bytes: number }
  | { type: "tool_call" | "tool_call_response"; tool: ToolName; bytes: number }
  | { type: "blob" | "uri" | "file"; modality: string; byte_size?: number }
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

/**
 * The string contents of the text parts of normalized messages: the texts
 * {@link contextSizes} splits into prose and media.
 */
export function textContents(messages: unknown[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    for (const part of partsOf(message)) {
      if (isRecord(part) && part.type === "text" && typeof part.content === "string") {
        texts.push(part.content);
      }
    }
  }
  return texts;
}

/** A text's split when the caller already has it, else undefined. */
export type KnownSplit = (text: string) => TextSplit | undefined;

/** A distinct bucket key per tool name; null is its own bucket. */
function toolKey(name: ToolName): string {
  return name === null ? "\0null" : `name:${name}`;
}

class Context {
  private readonly callNames = new Map<string, unknown>();

  constructor(
    messageLists: unknown[][],
    private readonly knownSplit: KnownSplit,
  ) {
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

  partEntry(part: unknown): PartEntry | PartEntry[] {
    if (!isRecord(part)) return { type: "unknown" };
    switch (part.type) {
      case "text": {
        const content = part.content ?? null;
        if (typeof content !== "string") return { type: "text", bytes: canonicalBytes(content) };
        const { proseBytes, tokens } = this.knownSplit(content) ?? splitMedia(content);
        if (tokens.length === 0) return { type: "text", bytes: proseBytes };
        return [{ type: "text", bytes: proseBytes }, ...tokens.map(mediaEntry)];
      }
      case "tool_call":
        return { type: "tool_call", tool: asToolName(part.name), bytes: canonicalBytes(part) };
      case "tool_call_response": {
        const name = typeof part.id === "string" ? this.callNames.get(part.id) : undefined;
        return { type: "tool_call_response", tool: asToolName(name), bytes: canonicalBytes(part) };
      }
      case "blob":
      case "uri":
      case "file": {
        const entry: { type: string; modality?: string; byte_size?: number } = { type: part.type };
        entry.modality =
          typeof part.modality === "string"
            ? part.modality
            : (modalityOf(part.mime_type) ?? "document");
        const size = part.byte_size;
        if (typeof size === "number" && Number.isSafeInteger(size) && size >= 0) {
          entry.byte_size = size;
        }
        return entry;
      }
      default:
        return { type: typeof part.type === "string" ? part.type : "unknown" };
    }
  }

  messageEntry(message: unknown): MessageEntry {
    const role = isRecord(message) ? message.role : undefined;
    return {
      role: roleName(role),
      parts: partsOf(message).flatMap((part) => this.partEntry(part)),
    };
  }
}

/**
 * The role a message entry reports. A message with no role (an explicit
 * `null`, which the normalizer keeps on the message, or none to read) is
 * reported as `user`, the role `fold` already counts its bytes under, rather
 * than as a spelling of null that differs between languages.
 */
function roleName(role: unknown): string {
  if (role === null || role === undefined) return "user";
  return typeof role === "string" ? role : String(role);
}

/**
 * A media token found inside a text part, as the blob it is: its modality
 * from its mime type (document when the token names none, the contract's
 * fallback for media with no hint), and its size when known.
 */
function mediaEntry(token: MediaToken): PartEntry {
  const entry: { type: string; modality?: string; byte_size?: number } = { type: "blob" };
  entry.modality = modalityOf(token.mime) ?? "document";
  if (token.byteSize !== undefined) entry.byte_size = token.byteSize;
  return entry;
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
 * `knownSplit` hands back a text's split the caller's own strip already
 * made, so it is not stripped twice; one it does not know is split here.
 */
export function contextSizes(
  tools: unknown[] | undefined,
  inputMessages: unknown[] | undefined,
  outputMessages: unknown[] | undefined,
  knownSplit: KnownSplit = () => undefined,
): string {
  try {
    const toolList = asList(tools);
    const inputs = asList(inputMessages);
    const outputs = asList(outputMessages);
    const context = new Context([inputs ?? [], outputs ?? []], knownSplit);

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
