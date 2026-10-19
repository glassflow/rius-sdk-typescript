/**
 * Media parts: what every producer's image, audio and file content becomes,
 * and how a raw payload is stripped of inline media in place.
 *
 * The rules are rius-semconv's `registry/media_parts.yaml`, shared with the
 * Python SDK and the sink. After normalization a media part is exactly one of
 *
 *   blob  {type: "blob", modality, mime_type?, byte_size?, stripped_reason}
 *   uri   {type: "uri", modality, mime_type?, uri}
 *   file  {type: "file", modality, mime_type?, file_id}
 *
 * and inline bytes never survive: a blob never carries `content`. The
 * modality comes from the MIME type when it is known, else from the
 * provider's part kind, and is never guessed as image for a non-image type.
 *
 * {@link stripRawPayload} is a port of the registry's reference
 * implementation (`strip_raw_payload` in generators/media_parts.py). Its
 * output must be byte-identical to the reference's, so the payload is never
 * parsed and re-serialized: the parser keeps every value's span on the text,
 * and only the media tokens it finds are replaced. Positions here are UTF-16
 * units where the reference counts code points; every boundary an edit can
 * fall on is an ASCII character, so the two agree on every edit.
 */

/** The modality vocabulary (the upstream enum). */
export type Modality = "image" | "video" | "audio" | "document";

/** Our default policy removed the inline bytes. */
export const NOT_CAPTURED = "not_captured";
/** The instrumentor dropped or replaced the payload before we saw it. */
export const REDACTED_UPSTREAM = "redacted_upstream";

// --- the rules, as the registry writes them -----------------------------------

/** The replacement text a media token in a raw payload becomes. */
export const REPLACEMENT_FORMAT = "[stripped <mime> <byte_size> bytes]";
export const REPLACEMENT_UNKNOWN = "unknown";
/** A mime type a replacement (or a part) may hold: token/token. */
export const MIME_PATTERN = "[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+";

/** Rule (b): a data URL anywhere in a string. Groups: mime, last parameter, base64. */
export const DATA_URL_PATTERN =
  '[dD][aA][tT][aA]:([^;,:\\t\\n\\f\\r "]*)(;[^;,:\\t\\n\\f\\r "]*)*;base64,([A-Za-z0-9+/_-]*={0,2})';

/** Rule (d): a Buffer object, `{"type": "Buffer", "data": [...]}`. */
export const BUFFER_RULE = {
  type: "Buffer",
  arrayKey: "data",
  mimeKeys: ["media_type", "mediaType", "mime_type", "mimeType"],
} as const;

/** Rule (e): a base64 string under a keyed member. */
export const KEYED_RULE = {
  keys: ["data", "b64_json", "result"],
  siblingKeys: ["media_type", "mediaType", "mime_type", "mimeType", "output_format"],
  parentKeys: ["input_audio", "audio", "inline_data", "inlineData"],
  sourceKey: "source",
  sourceType: "base64",
  blobType: "blob",
  blobKey: "content",
  mimeKeys: ["media_type", "mediaType", "mime_type", "mimeType"],
  mimeFormats: [
    { key: "output_format", mime: "image/<value>" },
    { key: "format", mime: "audio/<value>", parentKeys: ["input_audio", "audio"] },
  ],
} as const;

/** How deep a JSON candidate may nest, arrays and objects together. */
export const MAX_DEPTH = 64;

/**
 * How deep a message key may nest for its media parts to be rebuilt, far
 * above any real message nesting: the strip's limit would leave a blob in a
 * message nested deeper than 64 (a tool call's arguments, say) as it came.
 * The sink and the Python SDK use the same limit; the parser recurses, and
 * Node's stack ends near 3000.
 */
const MESSAGE_MAX_DEPTH = 1000;

// --- sizes, mime types, replacements --------------------------------------------

const MIME = new RegExp(`^${MIME_PATTERN}$`);
const DATA_URL = new RegExp(DATA_URL_PATTERN, "g");
const WHOLE_DATA_URL = new RegExp(`^${DATA_URL_PATTERN}$`);

/** The whitespace a size removes and a JSON candidate trims: ASCII only. */
const ASCII_WHITESPACE = /[ \t\n\r]/g;
const BASE64_ALPHABETS = /^[A-Za-z0-9+/_-]*$/;
const STANDARD_EXTRA = /[+/]/;
const URL_SAFE_EXTRA = /[-_]/;

/** Whether a value is a token/token mime type, the whole of it. */
export function isMime(value: unknown): value is string {
  return typeof value === "string" && MIME.test(value);
}

/**
 * The decoded size of a base64 string, or undefined (unknown) when it is not
 * valid: one alphabet, at most two trailing `=`, a length (padding counted)
 * that is a multiple of 4. Space, tab, newline and carriage return go first.
 * Never a stdlib decoder: decoders differ on whitespace, URL-safe input and
 * padding.
 */
export function base64Size(value: string): number | undefined {
  const text = value.replace(ASCII_WHITESPACE, "");
  const body = text.replace(/=+$/, "");
  const padding = text.length - body.length;
  if (padding > 2 || text.length % 4 !== 0 || !BASE64_ALPHABETS.test(body)) return undefined;
  if (STANDARD_EXTRA.test(body) && URL_SAFE_EXTRA.test(body)) return undefined;
  return (text.length * 3) / 4 - padding;
}

/** The text a media token in a raw payload is replaced by. */
function replacement(mime: string | undefined, byteSize: number | undefined): string {
  // Function replacers: a mime may hold `$&`, which a string replacement reads.
  return REPLACEMENT_FORMAT.replace("<mime>", () => mime ?? REPLACEMENT_UNKNOWN).replace(
    "<byte_size>",
    () => (byteSize === undefined ? REPLACEMENT_UNKNOWN : String(byteSize)),
  );
}

const [REPLACEMENT_HEAD, REPLACEMENT_REST] = REPLACEMENT_FORMAT.split("<mime>");
const [REPLACEMENT_BETWEEN, REPLACEMENT_TAIL] = REPLACEMENT_REST.split("<byte_size>");

/**
 * Whether a string is already a complete replacement: a mime that is unknown
 * or token/token, a size of ASCII digits or unknown. It is never stripped
 * again, and never context for rule (e), so stripping twice changes nothing.
 */
export function isReplacement(value: string): boolean {
  const head = REPLACEMENT_HEAD;
  const tail = REPLACEMENT_TAIL;
  if (value.length < head.length + REPLACEMENT_BETWEEN.length + tail.length) return false;
  if (!value.startsWith(head) || !value.endsWith(tail)) return false;
  const inner = value.slice(head.length, value.length - tail.length);
  const at = inner.lastIndexOf(REPLACEMENT_BETWEEN);
  if (at < 0) return false;
  const mime = inner.slice(0, at);
  const size = inner.slice(at + REPLACEMENT_BETWEEN.length);
  const digits = /^[0-9]+$/.test(size);
  return (mime === REPLACEMENT_UNKNOWN || isMime(mime)) && (digits || size === REPLACEMENT_UNKNOWN);
}

/**
 * Text as it is written inside a JSON string: the minimal escapes
 * JSON.stringify writes and no others, a lone surrogate as `\udxxx`.
 */
function jsonEscape(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else if (code >= 0xd800 && code < 0xdc00 && isLowSurrogate(text.charCodeAt(i + 1))) {
      out += text.slice(i, i + 2);
      i++;
    } else if (code >= 0xd800 && code < 0xe000) out += `\\u${code.toString(16)}`;
    else out += ch;
  }
  return out;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code < 0xe000;
}

// --- the JSON a candidate holds, with every value's span on the text ------------

/**
 * A JSON value: its span on the text, and for an object its members (every
 * duplicate, in document order), for an array its items, for a string its
 * decoded value and the raw span of each decoded UTF-16 unit.
 */
interface JsonNode {
  start: number;
  end: number;
  members?: [string, JsonNode][];
  items?: JsonNode[];
  text?: string;
  chars?: [number, number][];
}

class NotJson extends Error {}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
const LITERALS = ["true", "false", "null"] as const;

/**
 * Strict RFC 8259 (no NaN, Infinity, comments or trailing commas), at most
 * `maxDepth` arrays and objects deep counting the `depth` that already enclose
 * the text. The depth is counted here, never left to the language's recursion
 * limit, so no input makes the strip fail.
 */
class Parser {
  private i = 0;

  constructor(
    private readonly text: string,
    private depth: number,
    private readonly maxDepth = MAX_DEPTH,
  ) {}

  document(): JsonNode {
    this.space();
    const node = this.value();
    this.space();
    if (this.i !== this.text.length) throw new NotJson();
    return node;
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > this.maxDepth) throw new NotJson();
  }

  private space(): void {
    while (this.i < this.text.length && " \t\n\r".includes(this.text[this.i])) this.i++;
  }

  private expect(ch: string): void {
    if (this.text[this.i] !== ch) throw new NotJson();
    this.i++;
  }

  private value(): JsonNode {
    const ch = this.text[this.i];
    if (ch === "{") return this.object();
    if (ch === "[") return this.array();
    if (ch === '"') return this.string();
    for (const word of LITERALS) {
      if (this.text.startsWith(word, this.i)) {
        const start = this.i;
        this.i += word.length;
        return { start, end: this.i };
      }
    }
    NUMBER.lastIndex = this.i;
    const match = NUMBER.exec(this.text);
    if (match === null) throw new NotJson();
    const start = this.i;
    this.i += match[0].length;
    return { start, end: this.i };
  }

  private object(): JsonNode {
    const start = this.i;
    this.expect("{");
    this.enter();
    const members: [string, JsonNode][] = [];
    this.space();
    if (this.text[this.i] === "}") {
      this.i++;
    } else {
      for (;;) {
        this.space();
        const key = this.string();
        this.space();
        this.expect(":");
        this.space();
        members.push([key.text as string, this.value()]);
        this.space();
        if (this.text[this.i] === ",") {
          this.i++;
          continue;
        }
        this.expect("}");
        break;
      }
    }
    this.depth -= 1;
    return { start, end: this.i, members };
  }

  private array(): JsonNode {
    const start = this.i;
    this.expect("[");
    this.enter();
    const items: JsonNode[] = [];
    this.space();
    if (this.text[this.i] === "]") {
      this.i++;
    } else {
      for (;;) {
        this.space();
        items.push(this.value());
        this.space();
        if (this.text[this.i] === ",") {
          this.i++;
          continue;
        }
        this.expect("]");
        break;
      }
    }
    this.depth -= 1;
    return { start, end: this.i, items };
  }

  private string(): JsonNode {
    const start = this.i;
    this.expect('"');
    const { text } = this;
    let out = "";
    const chars: [number, number][] = [];
    for (;;) {
      if (this.i >= text.length) throw new NotJson();
      const ch = text[this.i];
      const at = this.i;
      if (ch === '"') {
        this.i++;
        break;
      }
      if (ch < " ") throw new NotJson();
      if (ch !== "\\") {
        out += ch;
        this.i++;
        chars.push([at, this.i]);
        continue;
      }
      const kind = text.slice(this.i + 1, this.i + 2);
      if (Object.hasOwn(SHORT_ESCAPES, kind)) {
        out += SHORT_ESCAPES[kind];
        this.i += 2;
        chars.push([at, this.i]);
      } else if (kind === "u") {
        const code = this.hex4(this.i + 2);
        this.i += 6;
        if (code >= 0xd800 && code < 0xdc00 && text.startsWith("\\u", this.i)) {
          const low = this.hex4(this.i + 2);
          if (isLowSurrogate(low)) {
            this.i += 6;
            // One character in the reference, two units here: both map to
            // the whole escape pair, which no edit ever splits.
            out += String.fromCharCode(code, low);
            chars.push([at, this.i], [at, this.i]);
            continue;
          }
        }
        out += String.fromCharCode(code);
        chars.push([at, this.i]);
      } else {
        throw new NotJson();
      }
    }
    return { start, end: this.i, text: out, chars };
  }

  private hex4(at: number): number {
    const digits = this.text.slice(at, at + 4);
    if (!HEX4.test(digits)) throw new NotJson();
    return Number.parseInt(digits, 16);
  }
}

function parse(text: string, depth: number, maxDepth = MAX_DEPTH): JsonNode | undefined {
  try {
    return new Parser(text, depth, maxDepth).document();
  } catch (error) {
    if (error instanceof NotJson) return undefined;
    throw error;
  }
}

/** Starts with `{` or `[` once leading ASCII whitespace is trimmed. */
function isJsonCandidate(value: string): boolean {
  const first = value.replace(/^[ \t\n\r]*/, "")[0];
  return first === "{" || first === "[";
}

// --- the detection rules on parsed members -------------------------------------

type Members = [string, JsonNode][];

/** A media token a strip replaced: its rule, mime type and size (undefined is unknown). */
export interface MediaToken {
  rule: "b" | "d" | "e";
  mime: string | undefined;
  byteSize: number | undefined;
}

/** An edit on a text: replace text[start, end) by the string. */
type Edit = [start: number, end: number, text: string];

/** The first member named `key`, in document order, for which `ok` holds. */
function first(members: Members, key: string, ok: (node: JsonNode) => boolean) {
  for (const [k, node] of members) if (k === key && ok(node)) return node;
  return undefined;
}

function isStringEqual(value: string): (node: JsonNode) => boolean {
  return (node) => node.text === value;
}

/** A sibling rule (e) reads: a non-empty string that is not a complete replacement. */
function siblingString(node: JsonNode): boolean {
  return node.text !== undefined && node.text !== "" && !isReplacement(node.text);
}

/** A string rule (e) replaces: the same test, so stripping twice changes nothing. */
const keyedString = siblingString;

/** The first mime key, in the list's order, with a token/token value. */
function mimeKey(keys: readonly string[], members: Members): string | undefined {
  for (const key of keys) {
    const node = first(members, key, (n) => siblingString(n) && isMime(n.text));
    if (node !== undefined) return node.text;
  }
  return undefined;
}

/** Rule (d): the byte array of a Buffer object, or undefined when it is not one. */
function bufferData(members: Members): JsonNode[] | undefined {
  if (first(members, "type", isStringEqual(BUFFER_RULE.type)) === undefined) return undefined;
  return first(members, BUFFER_RULE.arrayKey, (n) => n.items !== undefined && n.items.length > 0)
    ?.items;
}

function includes(list: readonly string[], value: string | undefined): boolean {
  return value !== undefined && list.includes(value);
}

/**
 * Rule (e): the positions of the members holding base64 media, duplicates
 * included: a keyed string, or an array holding one directly.
 */
function keyedBase64(members: Members, parentKey: string | undefined): Set<number> {
  const rule = KEYED_RULE;
  const context =
    members.some(([k, v]) => includes(rule.siblingKeys, k) && siblingString(v)) ||
    includes(rule.parentKeys, parentKey) ||
    (parentKey === rule.sourceKey &&
      first(members, "type", isStringEqual(rule.sourceType)) !== undefined);
  const keys = new Set<string>(context ? rule.keys : []);
  if (first(members, "type", isStringEqual(rule.blobType)) !== undefined) keys.add(rule.blobKey);
  const out = new Set<number>();
  members.forEach(([k, v], i) => {
    if (keys.has(k) && (keyedString(v) || (v.items?.some(keyedString) ?? false))) out.add(i);
  });
  return out;
}

/** Rule (e)'s mime type: a mime key, else a mime format, else unknown. */
function keyedMime(members: Members, parentKey: string | undefined): string | undefined {
  const mime = mimeKey(KEYED_RULE.mimeKeys, members);
  if (mime !== undefined) return mime;
  for (const entry of KEYED_RULE.mimeFormats) {
    if ("parentKeys" in entry && !includes(entry.parentKeys, parentKey)) continue;
    const sibling = first(members, entry.key, siblingString)?.text;
    if (sibling === undefined) continue;
    const candidate = entry.mime.replace("<value>", () => sibling);
    if (isMime(candidate)) return candidate;
  }
  return undefined;
}

// --- the strip --------------------------------------------------------------------

function literal(mime: string | undefined, byteSize: number | undefined): string {
  return `"${jsonEscape(replacement(mime, byteSize))}"`;
}

/**
 * The edits on a string's text (an attribute, or a JSON string's decoded value
 * inside `depth` arrays and objects): the JSON walk when it is a candidate
 * that parses, else rule (b) alone. A complete replacement is left as it is.
 */
function stripText(text: string, tokens: MediaToken[], depth: number): Edit[] {
  if (isReplacement(text)) return [];
  if (isJsonCandidate(text)) {
    const document = parse(text, depth);
    if (document !== undefined) {
      const edits: Edit[] = [];
      walk(document, undefined, undefined, depth, tokens, edits);
      return edits;
    }
  }
  const edits: Edit[] = [];
  for (const match of text.matchAll(DATA_URL)) {
    const mime = isMime(match[1]) ? match[1] : undefined;
    const byteSize = base64Size(match[3]);
    tokens.push({ rule: "b", mime, byteSize });
    const start = match.index ?? 0;
    edits.push([start, start + match[0].length, replacement(mime, byteSize)]);
  }
  return edits;
}

/**
 * Rules (d), then (e), then (b), on one value, in document order. `holder` is
 * the nearest enclosing object (through arrays), for rule (d)'s mime type;
 * `depth` is how many arrays and objects enclose the value. Every rule reads
 * the original text, never an edit the same pass made.
 */
function walk(
  node: JsonNode,
  parentKey: string | undefined,
  holder: Members | undefined,
  depth: number,
  tokens: MediaToken[],
  edits: Edit[],
): void {
  if (node.members !== undefined) {
    const { members } = node;
    const data = bufferData(members);
    if (data !== undefined) {
      const mime = mimeKey(BUFFER_RULE.mimeKeys, holder ?? []);
      tokens.push({ rule: "d", mime, byteSize: data.length });
      edits.push([node.start, node.end, literal(mime, data.length)]);
      return;
    }
    const keyed = keyedBase64(members, parentKey);
    const mime = keyed.size > 0 ? keyedMime(members, parentKey) : undefined;
    members.forEach(([key, child], i) => {
      if (!keyed.has(i)) {
        walk(child, key, members, depth + 1, tokens, edits);
      } else if (child.items === undefined) {
        keyedToken(child, mime, tokens, edits);
      } else {
        // A string array under the key: each string element is a token.
        for (const item of child.items) {
          if (keyedString(item)) keyedToken(item, mime, tokens, edits);
          else walk(item, key, members, depth + 2, tokens, edits);
        }
      }
    });
  } else if (node.items !== undefined) {
    for (const child of node.items) walk(child, parentKey, holder, depth + 1, tokens, edits);
  } else if (node.text !== undefined && node.chars !== undefined) {
    // A JSON string: strip its decoded value, then map each edit back to the
    // raw characters and write it escaped for this level.
    const { chars } = node;
    for (const [start, end, text] of stripText(node.text, tokens, depth)) {
      const rawStart = chars[start][0];
      const rawEnd = end > start ? chars[end - 1][1] : rawStart;
      edits.push([rawStart, rawEnd, jsonEscape(text)]);
    }
  }
}

/** Rule (e) on one string literal: replaced whole, quotes included. */
function keyedToken(
  node: JsonNode,
  mime: string | undefined,
  tokens: MediaToken[],
  edits: Edit[],
): void {
  const byteSize = base64Size(node.text ?? "");
  tokens.push({ rule: "e", mime, byteSize });
  edits.push([node.start, node.end, literal(mime, byteSize)]);
}

function apply(text: string, edits: Edit[]): string {
  let out = "";
  let last = 0;
  for (const [start, end, replaced] of edits) {
    out += text.slice(last, start) + replaced;
    last = end;
  }
  return out + text.slice(last);
}

/** The stripped string and the tokens replaced in it, in document order. */
export function strip(text: string): { text: string; tokens: MediaToken[] } {
  const tokens: MediaToken[] = [];
  return { text: apply(text, stripText(text, tokens, 0)), tokens };
}

/**
 * A text's prose and its media, apart: the UTF-8 bytes of the text with every
 * media token the strip finds taken out (the stripped text, less each
 * replacement it wrote), and the tokens themselves. Each token is one
 * replacement, so the two sums are exact.
 */
export function splitMedia(text: string): { proseBytes: number; tokens: MediaToken[] } {
  const tokens: MediaToken[] = [];
  const edits = stripText(text, tokens, 0);
  const written = edits.reduce((sum, [, , replaced]) => sum + Buffer.byteLength(replaced), 0);
  return { proseBytes: Buffer.byteLength(apply(text, edits)) - written, tokens };
}

/**
 * A raw payload with every media token replaced in place and every other
 * character unchanged. Never throws: the parser's depth limit bounds every
 * recursion.
 */
export function stripRawPayload(text: string): string {
  return strip(text).text;
}

// --- parts ------------------------------------------------------------------------

/**
 * The modality of a token/token MIME type: image/*, audio/*, video/*, and
 * document for anything else (PDF, text/*, office formats). Undefined when
 * there is no valid MIME type, for the caller's part-kind fallback.
 */
export function modalityOf(mime: unknown): Modality | undefined {
  if (!isMime(mime)) return undefined;
  const type = mime.slice(0, mime.indexOf("/")).toLowerCase();
  if (type === "image" || type === "audio" || type === "video") return type;
  return "document";
}

type Part = Record<string, unknown>;

function withMime(part: Part, mime: unknown): Part {
  if (isMime(mime)) part.mime_type = mime;
  return part;
}

/** A blob part: inline bytes, never their content. */
export function blobPart(
  kind: Modality,
  mime: unknown,
  byteSize: number | undefined,
  reason: string,
): Part {
  const part = withMime({ type: "blob", modality: modalityOf(mime) ?? kind }, mime);
  if (byteSize !== undefined) part.byte_size = byteSize;
  part.stripped_reason = reason;
  return part;
}

/** A uri part: media referenced by URL. */
export function uriPart(kind: Modality, mime: unknown, uri: string): Part {
  const part = withMime({ type: "uri", modality: modalityOf(mime) ?? kind }, mime);
  part.uri = uri;
  return part;
}

/** A file part: a provider file id. */
export function fileIdPart(kind: Modality, mime: unknown, fileId: string): Part {
  const part = withMime({ type: "file", modality: modalityOf(mime) ?? kind }, mime);
  part.file_id = fileId;
  return part;
}

/** Whether a string is a data URL (the scheme in any case). */
export function isDataUrl(value: string): boolean {
  return /^[dD][aA][tT][aA]:/.test(value);
}

/** What OpenInference writes in place of an image over its size limit. */
export const OPENINFERENCE_REDACTED = "__REDACTED__";

/**
 * A data URL as a blob: its own media type, and the size of its base64 run.
 * One that holds no bytes (`data:None;url,None`, what OpenInference's
 * Anthropic instrumentor writes for a url image) was emptied before we saw
 * it, so it is redacted upstream.
 */
export function dataUrlBlob(url: string, kind: Modality, mimeHint?: unknown): Part {
  const match = WHOLE_DATA_URL.exec(url);
  if (match !== null) {
    const mime = isMime(match[1]) ? match[1] : mimeHint;
    return blobPart(kind, mime, base64Size(match[3]), NOT_CAPTURED);
  }
  const header = url.slice(5).split(/[;,]/, 1)[0];
  const comma = url.indexOf(",");
  const payload = comma < 0 ? "" : url.slice(comma + 1);
  const mime = isMime(header) ? header : mimeHint;
  if (payload === "" || payload === "None") {
    return blobPart(kind, mime, undefined, REDACTED_UPSTREAM);
  }
  return blobPart(kind, mime, undefined, NOT_CAPTURED);
}

/** A URL as a part: a data URL is a blob, anything else a uri. */
export function urlPart(url: string, kind: Modality, mime?: unknown): Part {
  return isDataUrl(url) ? dataUrlBlob(url, kind, mime) : uriPart(kind, mime, url);
}

/** Inline base64 (not a data URL) as a blob. */
export function base64Blob(data: string, kind: Modality, mime: unknown): Part {
  if (isDataUrl(data)) return dataUrlBlob(data, kind, mime);
  return blobPart(kind, mime, base64Size(data), NOT_CAPTURED);
}

const EXTENSION_MODALITY: Readonly<Record<string, Modality>> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  wav: "audio",
  mp3: "audio",
  m4a: "audio",
  ogg: "audio",
  flac: "audio",
  mp4: "video",
  mov: "video",
  webm: "video",
};

/** The modality a filename's extension names; document when it names none we know. */
function filenameModality(filename: unknown): Modality {
  if (typeof filename !== "string") return "document";
  const dot = filename.lastIndexOf(".");
  const extension = dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
  return Object.hasOwn(EXTENSION_MODALITY, extension) ? EXTENSION_MODALITY[extension] : "document";
}

/** The modality a URI's filename extension names (its path, query and fragment cut). */
function uriModality(uri: string): Modality {
  const path = uri.split("#", 1)[0].split("?", 1)[0];
  return filenameModality(path.slice(path.lastIndexOf("/") + 1));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The part kind's modality, for a part with no MIME type. */
function kindModality(type: unknown): Modality {
  return type === "image" ? "image" : "document";
}

/**
 * A provider's media content item as semconv parts, or undefined when it is
 * not a media item this module knows (it then passes through unchanged as a
 * generic part). Covers the pass-through rows of the mapping table: OpenAI
 * chat and Responses, Anthropic, Gemini, and native semconv media parts.
 */
export function providerMediaParts(item: unknown): Part[] | undefined {
  if (!isRecord(item)) return undefined;
  switch (item.type) {
    case "blob":
    case "uri":
    case "file":
      if (item.type !== "file" || !isRecord(item.file)) return nativeMediaPart(item);
      return openaiFile(item.file);
    case "image_url": {
      const image = item.image_url;
      const url = isRecord(image) ? image.url : image;
      return typeof url === "string" ? [urlPart(url, "image")] : undefined;
    }
    case "input_audio": {
      const audio = item.input_audio;
      if (!isRecord(audio) || typeof audio.data !== "string") return undefined;
      const format = asString(audio.format);
      return [base64Blob(audio.data, "audio", format && `audio/${format}`)];
    }
    case "input_image": {
      const url = asString(item.image_url);
      if (url !== undefined) return [urlPart(url, "image")];
      const fileId = asString(item.file_id);
      return fileId === undefined ? undefined : [fileIdPart("image", undefined, fileId)];
    }
    case "input_file":
      return openaiFile(item);
    case "image_generation_call": {
      if (typeof item.result !== "string") return undefined;
      const format = asString(item.output_format);
      return [base64Blob(item.result, "image", format && `image/${format}`)];
    }
    case "image":
    case "document":
      return anthropicSource(item.type, item.source);
    default:
      return geminiPart(item);
  }
}

/**
 * OpenAI's file item: chat's `file {file_id | file_data, filename}` or the
 * Responses `input_file {file_id | file_data | file_url, filename}`. File data
 * is a data URL (its mime type names the modality) or bare base64, whose
 * modality comes from the filename.
 */
function openaiFile(file: Record<string, unknown>): Part[] | undefined {
  const kind = filenameModality(file.filename);
  const fileId = asString(file.file_id);
  if (fileId !== undefined) return [fileIdPart(kind, undefined, fileId)];
  const data = asString(file.file_data);
  if (data !== undefined) return [base64Blob(data, kind, undefined)];
  const url = asString(file.file_url);
  return url === undefined ? undefined : [urlPart(url, kind)];
}

/**
 * An Anthropic image or document block by its source: base64 is a blob, url a
 * uri, file a file. A text or content document is text to the model, so it
 * becomes text parts.
 */
function anthropicSource(type: string, source: unknown): Part[] | undefined {
  if (!isRecord(source)) return undefined;
  const kind = kindModality(type);
  switch (source.type) {
    case "base64":
      return typeof source.data === "string"
        ? [base64Blob(source.data, kind, source.media_type)]
        : undefined;
    case "url":
      return typeof source.url === "string"
        ? [urlPart(source.url, kind, source.media_type)]
        : undefined;
    case "file":
      return typeof source.file_id === "string"
        ? [fileIdPart(kind, source.media_type, source.file_id)]
        : undefined;
    case "text":
      return type === "document" && typeof source.data === "string"
        ? [{ type: "text", content: source.data }]
        : undefined;
    case "content":
      return type === "document" ? documentContent(source.content) : undefined;
    default:
      return undefined;
  }
}

/** A content document's blocks as text parts; a string is one. */
function documentContent(content: unknown): Part[] | undefined {
  if (typeof content === "string") return [{ type: "text", content }];
  if (!Array.isArray(content)) return undefined;
  const parts: Part[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", content: block.text });
    }
  }
  return parts;
}

/**
 * A Gemini part, which has no type: `inline_data` is a blob, `file_data` a uri
 * (a blob when its URI is a data URL).
 */
function geminiPart(item: Record<string, unknown>): Part[] | undefined {
  const inline = item.inline_data ?? item.inlineData;
  if (isRecord(inline) && typeof inline.data === "string") {
    return [base64Blob(inline.data, "document", inline.mime_type ?? inline.mimeType)];
  }
  const file = item.file_data ?? item.fileData;
  if (isRecord(file)) {
    const uri = file.file_uri ?? file.fileUri;
    if (typeof uri === "string") {
      return [urlPart(uri, uriModality(uri), file.mime_type ?? file.mimeType)];
    }
  }
  return undefined;
}

const MODALITIES: readonly string[] = ["image", "video", "audio", "document"];
const STRIPPED_REASONS: readonly string[] = [NOT_CAPTURED, REDACTED_UPSTREAM];

/**
 * A native semconv media part rebuilt into the normalized shape: the pinned
 * members in their order, extra members dropped, `mime_type` only when it is
 * token/token. A modality the part has is kept, else it is filled from the
 * MIME type, else (a uri) from its filename extension, else document. A blob
 * carrying content is stripped of it (sized from it, `not_captured`) and
 * takes its modality from its MIME type first (@ai-sdk/otel labels a PDF an
 * image). A uri holding a data URL is a blob, since a data URL is never a
 * uri. Undefined when it is not a media part this can read, which stays as
 * it came.
 */
export function nativeMediaPart(part: Record<string, unknown>): Part[] | undefined {
  const own = typeof part.modality === "string" && MODALITIES.includes(part.modality);
  const kind = (own ? part.modality : "document") as Modality;
  const mime = part.mime_type;
  const shaped = (type: string, fallback: Modality = "document"): Part => {
    const out: Part = { type, modality: own ? kind : (modalityOf(mime) ?? fallback) };
    if (isMime(mime)) out.mime_type = mime;
    return out;
  };
  switch (part.type) {
    case "blob": {
      if (typeof part.content === "string") return [base64Blob(part.content, kind, mime)];
      const out = shaped("blob");
      const size = part.byte_size;
      if (Number.isSafeInteger(size) && (size as number) >= 0) out.byte_size = size;
      out.stripped_reason =
        typeof part.stripped_reason === "string" && STRIPPED_REASONS.includes(part.stripped_reason)
          ? part.stripped_reason
          : part.content === undefined || part.content === null
            ? REDACTED_UPSTREAM
            : NOT_CAPTURED;
      return [out];
    }
    case "uri": {
      if (typeof part.uri !== "string") return undefined;
      if (isDataUrl(part.uri)) return [dataUrlBlob(part.uri, kind, mime)];
      const out = shaped("uri", uriModality(part.uri));
      out.uri = part.uri;
      return [out];
    }
    case "file": {
      if (typeof part.file_id !== "string") return undefined;
      const out = shaped("file");
      out.file_id = part.file_id;
      return [out];
    }
    default:
      return undefined;
  }
}

/** Every native media part of one part list, rebuilt where its bytes change. */
function partEdits(text: string, parts: JsonNode, edits: Edit[]): void {
  for (const node of parts.items ?? []) {
    if (node.members === undefined) continue;
    // Read as JSON.parse reads it: the last of a duplicated key wins.
    const media = nativeMediaPart(JSON.parse(text.slice(node.start, node.end)));
    if (media === undefined) continue;
    const encoded = media.map((part) => JSON.stringify(part)).join(",");
    if (encoded !== text.slice(node.start, node.end)) edits.push([node.start, node.end, encoded]);
  }
}

/**
 * A message key's native media parts rebuilt in place (see nativeMediaPart):
 * each part whose canonical encoding differs from its bytes is replaced by
 * it, compact, several parts comma-separated, and every other byte is kept as
 * it came. `messages` is a list of messages, each with its `parts` (the
 * last, as JSON.parse reads a duplicated key); otherwise the list is the
 * parts themselves, as system instructions are. A value that does not parse
 * is returned as it came. Canonical parts hold only token/token MIME types,
 * numbers and the producer's strings, which JSON.stringify escapes as
 * minimally as the strip does.
 */
export function rebuildNativeMediaParts(text: string, messages: boolean): string {
  if (!isJsonCandidate(text)) return text;
  const document = parse(text, 0, MESSAGE_MAX_DEPTH);
  if (document?.items === undefined) return text;
  const edits: Edit[] = [];
  if (!messages) {
    partEdits(text, document, edits);
  } else {
    for (const message of document.items) {
      let parts: JsonNode | undefined;
      for (const [key, value] of message.members ?? []) if (key === "parts") parts = value;
      if (parts !== undefined) partEdits(text, parts, edits);
    }
  }
  return edits.length > 0 ? apply(text, edits) : text;
}
