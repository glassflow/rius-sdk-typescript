/**
 * Message normalisation to the GenAI `{role, parts}` shape.
 *
 * A port of the Python SDK's `_normalize_message` / `_serialize_messages`:
 * both SDKs must write the same JSON into `gen_ai.input.messages` and
 * `gen_ai.output.messages`, or the console and every saved query see two
 * dialects. Accepts spec-conformant messages (passed through), OpenAI-style
 * `{role, content}` / `tool_calls` / tool-response messages, bare strings,
 * and falls back to a serialized text part for anything else. A provider's
 * image, audio or file item becomes a semconv `blob`, `uri` or `file` part
 * (see mediaParts.ts), and a blob never keeps its bytes.
 */
import { providerMediaParts } from "./mediaParts.js";
import { toAttributeValue } from "./serde.js";

type Part = Record<string, unknown>;
/** A message in the spec `{role, parts}` shape, as the normalizer returns it. */
export type Message = { role: unknown; parts: Part[] } & Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text for a part: strings verbatim, everything else JSON, as Python's serialize() does. */
function asText(value: unknown): string {
  return typeof value === "string" ? value : toAttributeValue(value);
}

/**
 * The message's own role, else the default. Only an ABSENT role defaults (an
 * `undefined` one is absent too, since JSON drops it): an explicit `null` is
 * kept, as Python's `dict.get` / `setdefault` keep a `None`.
 */
function roleOf(message: Record<string, unknown>, defaultRole: string): unknown {
  return message.role === undefined ? defaultRole : message.role;
}

/** One content-list entry into spec message parts. */
function normalizePart(item: unknown): Part[] {
  if (isRecord(item)) {
    // OpenAI multimodal text part {"type": "text", "text": ...}
    if (item.type === "text" && "text" in item) return [{ type: "text", content: item.text }];
    const media = providerMediaParts(item);
    if (media !== undefined) return media;
    if ("type" in item) return [item]; // already-typed part: pass through
  }
  return [{ type: "text", content: asText(item) }];
}

/** A spec part list with its media parts normalized; any other part as it is. */
function normalizeParts(parts: unknown): unknown {
  if (!Array.isArray(parts)) return parts;
  return parts.flatMap((part) => {
    // An empty list keeps the part too, as Python's `or [part]` does.
    const media = providerMediaParts(part);
    return media?.length ? media : [part];
  });
}

/**
 * OpenAI's audio response, `message.audio {data, transcript}`: an audio blob,
 * then the transcript as text.
 */
function audioParts(audio: unknown): Part[] {
  if (!isRecord(audio)) return [];
  const parts: Part[] = [];
  if (typeof audio.data === "string") {
    parts.push(...(providerMediaParts({ type: "input_audio", input_audio: audio }) ?? []));
  }
  if (typeof audio.transcript === "string") parts.push({ type: "text", content: audio.transcript });
  return parts;
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
    return {
      ...message,
      role: roleOf(message, defaultRole),
      parts: normalizeParts(message.parts),
    } as Message;
  }
  if (!("role" in message) && !("content" in message)) {
    // A bare output item, such as a Responses image_generation_call.
    const media = providerMediaParts(message);
    if (media !== undefined) return { role: defaultRole, parts: media };
  }

  const role = roleOf(message, defaultRole);
  if (role === "tool" && "tool_call_id" in message) {
    return {
      role: "tool",
      // Missing fields become null, never absent: Python's dict.get() writes
      // null for them, and the two SDKs' parts must serialize to the same
      // bytes for the context sizes to agree.
      parts: [
        {
          type: "tool_call_response",
          id: message.tool_call_id ?? null,
          response: message.content ?? null,
        },
      ],
    };
  }

  const parts: Part[] = [];
  const content = message.content;
  if (typeof content === "string") {
    parts.push({ type: "text", content });
  } else if (Array.isArray(content)) {
    for (const item of content) parts.push(...normalizePart(item));
  } else if (content !== null && content !== undefined) {
    parts.push({ type: "text", content: asText(content) });
  }
  parts.push(...audioParts(message.audio));
  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      if (!isRecord(call)) continue;
      const fn = isRecord(call.function) ? call.function : {};
      parts.push({
        type: "tool_call",
        id: call.id ?? null,
        name: fn.name ?? null,
        arguments: fn.arguments ?? null,
      });
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
  return toAttributeValue(normalizeMessages(messages, defaultRole));
}
