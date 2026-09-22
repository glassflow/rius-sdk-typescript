/**
 * Message normalisation to the GenAI `{role, parts}` shape.
 *
 * A port of the Python SDK's `_normalize_message` / `_serialize_messages`:
 * both SDKs must write the same JSON into `gen_ai.input.messages` and
 * `gen_ai.output.messages`, or the console and every saved query see two
 * dialects. Accepts spec-conformant messages (passed through), OpenAI-style
 * `{role, content}` / `tool_calls` / tool-response messages, bare strings,
 * and falls back to a serialized text part for anything else.
 */
import { toAttributeValue } from "./serde.js";

type Part = Record<string, unknown>;
/** A message in the spec `{role, parts}` shape, as the normalizer returns it. */
export type Message = { role: unknown; parts: Part[] } & Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text for a part: strings verbatim, everything else JSON, as Python's serialize() does. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  const text = toAttributeValue(value);
  return typeof text === "string" ? text : String(text);
}

/** One content-list entry into a spec message part. */
function normalizePart(item: unknown): Part {
  if (isRecord(item)) {
    // OpenAI multimodal text part {"type": "text", "text": ...}
    if (item.type === "text" && "text" in item) return { type: "text", content: item.text };
    if ("type" in item) return item; // already-typed part: pass through
  }
  return { type: "text", content: asText(item) };
}

/** One message into the spec `{role, parts: [...]}` shape. */
function normalizeMessage(message: unknown, defaultRole: string): Message {
  if (typeof message === "string") {
    return { role: defaultRole, parts: [{ type: "text", content: message }] };
  }
  if (!isRecord(message)) {
    return { role: defaultRole, parts: [{ type: "text", content: asText(message) }] };
  }
  if ("parts" in message) {
    return { ...message, role: message.role ?? defaultRole } as Message;
  }

  const role = message.role ?? defaultRole;
  if (role === "tool" && "tool_call_id" in message) {
    return {
      role: "tool",
      parts: [{ type: "tool_call_response", id: message.tool_call_id, response: message.content }],
    };
  }

  const parts: Part[] = [];
  const content = message.content;
  if (typeof content === "string") {
    parts.push({ type: "text", content });
  } else if (Array.isArray(content)) {
    for (const item of content) parts.push(normalizePart(item));
  } else if (content !== null && content !== undefined) {
    parts.push({ type: "text", content: asText(content) });
  }
  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      if (!isRecord(call)) continue;
      const fn = isRecord(call.function) ? call.function : {};
      parts.push({ type: "tool_call", id: call.id, name: fn.name, arguments: fn.arguments });
    }
  }
  return { role, parts };
}

/**
 * Normalize one message or a list of them to the spec `{role, parts}` list.
 * Exposed separately from the serializer so the context-size computation can
 * walk the same normalized list the content attribute is serialized from:
 * normalization runs once, and sizes are measured before truncation.
 */
export function normalizeMessages(messages: unknown, defaultRole: string): Message[] {
  const list = Array.isArray(messages) ? messages : [messages];
  return list.map((message) => normalizeMessage(message, defaultRole));
}

/** Serialize to the spec message-array shape (a JSON string attribute). */
export function serializeMessages(messages: unknown, defaultRole: string): string {
  return toAttributeValue(normalizeMessages(messages, defaultRole)) as string;
}
