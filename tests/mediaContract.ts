// The media contract's canonical part shape, read from rius-semconv's
// registry/media_parts.yaml (synced into tests/fixtures/semconv/media_parts.json
// by scripts/sync-semconv-fixtures.sh).
//
// A normalized media part is canonical when its members are exactly the
// contract's, in its order, none null, with a modality and the member its type
// cannot do without: a blob's stripped_reason, a uri's uri, a file's file_id. A
// bare {"type":"file"} is not. Each value is one the contract allows: a
// modality and stripped_reason from its vocabularies, a token/token mime_type, a
// whole byte_size from 0 to 2^53 - 1, and a string uri or file_id.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export type PartExample = { name: string; from: string; part: string };
export type MessageExample = {
  name: string;
  from: string;
  source: string;
  attributes?: Record<string, string>;
  input: string;
  output: string;
};

export const CONTRACT = JSON.parse(
  readFileSync(join(HERE, "fixtures/semconv/media_parts.json"), "utf8"),
) as {
  modalities: string[];
  stripped_reasons: Record<string, string>;
  raw_payloads: { replacement: { mime_pattern: string } };
  part_shapes: {
    members: Record<string, string[]>;
    examples: PartExample[];
    message_examples?: MessageExample[];
  };
};

const REQUIRED: Record<string, string> = { blob: "stripped_reason", uri: "uri", file: "file_id" };
const MIME_PATTERN = new RegExp(`^(?:${CONTRACT.raw_payloads.replacement.mime_pattern})$`);

export const MESSAGE_KEYS = [
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.system_instructions",
];

const isMediaType = (type: unknown): type is string =>
  typeof type === "string" && Object.hasOwn(CONTRACT.part_shapes.members, type);

/** What keeps one media part (type blob, uri or file) from being canonical. */
export function canonicalErrors(part: Record<string, unknown>): string[] {
  const type = part.type as string;
  const members = CONTRACT.part_shapes.members[type];
  const keys = Object.keys(part);
  const errors: string[] = [];
  if (JSON.stringify(keys) !== JSON.stringify(members.filter((m) => keys.includes(m)))) {
    errors.push(`members ${keys} are not in the order ${members}`);
  }
  for (const m of ["modality", REQUIRED[type]]) if (!keys.includes(m)) errors.push(`no ${m}`);
  for (const [k, v] of Object.entries(part)) if (v === null) errors.push(`${k} is null`);
  if (keys.includes("modality") && !CONTRACT.modalities.includes(part.modality as string)) {
    errors.push(`modality ${JSON.stringify(part.modality)}`);
  }
  if (type === "blob" && !Object.hasOwn(CONTRACT.stripped_reasons, String(part.stripped_reason))) {
    errors.push(`stripped_reason ${JSON.stringify(part.stripped_reason)}`);
  }
  const mime = part.mime_type;
  if (mime !== undefined && !(typeof mime === "string" && MIME_PATTERN.test(mime))) {
    errors.push(`mime_type ${JSON.stringify(mime)} is not token/token`);
  }
  const size = part.byte_size;
  if (size !== undefined && !(Number.isSafeInteger(size) && (size as number) >= 0)) {
    errors.push(`byte_size ${JSON.stringify(size)} is not a whole number from 0 to 2^53 - 1`);
  }
  for (const m of ["uri", "file_id"]) {
    const value = part[m];
    if (value !== undefined && value !== null && typeof value !== "string") {
      errors.push(`${m} ${JSON.stringify(value)} is not a string`);
    }
  }
  return errors;
}

/**
 * Every media part of a message-key value: each message's parts, or the
 * system instructions' parts. A value that is not JSON holds none.
 */
export function mediaPartsIn(value: unknown): Record<string, unknown>[] {
  let messages: unknown = value;
  if (typeof value === "string") {
    try {
      messages = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(messages)) return [];
  const parts: Record<string, unknown>[] = [];
  for (const item of messages) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    for (const part of Array.isArray(record.parts) ? record.parts : [record]) {
      if (typeof part === "object" && part !== null && isMediaType(part.type)) parts.push(part);
    }
  }
  return parts;
}

/** Every media part of a span's message keys that is not canonical, with why. */
export function nonCanonical(attributes: Record<string, unknown>): string[] {
  return MESSAGE_KEYS.flatMap((key) =>
    mediaPartsIn(attributes[key])
      .map((part) => [part, canonicalErrors(part)] as const)
      .filter(([, errors]) => errors.length > 0)
      .map(([part, errors]) => `${key} ${JSON.stringify(part)}: ${errors.join(", ")}`),
  );
}
