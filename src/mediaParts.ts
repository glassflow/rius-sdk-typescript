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

/**
 * Rule (b): a data URL anywhere in a string. Groups: mime, last parameter,
 * base64 run (its line breaks, indent and quoting `>` included), last
 * continuation line. The run goes on over a line break only after a first
 * line of at most 76 characters, as MIME wraps it.
 */
export const DATA_URL_PATTERN =
  '[dD][aA][tT][aA]:([^;,:\\t\\n\\f\\r "]*)(;[^;,:\\t\\n\\f\\r "]*)*;base64,([A-Za-z0-9+/_-]{0,76}(\\r{0,1}\\n[ \\t>]*[A-Za-z0-9+/_-]+)*[A-Za-z0-9+/_-]*={0,2})';

/**
 * Rule (b) in the text of a JSON candidate that does not parse: the pattern,
 * its run going on over a line break written as a JSON escape too (a
 * backslash, an optional r, an optional backslash, then n), after any raw
 * ones. A fifth group, the last escaped line.
 */
export const ESCAPED_DATA_URL_PATTERN =
  '[dD][aA][tT][aA]:([^;,:\\t\\n\\f\\r "]*)(;[^;,:\\t\\n\\f\\r "]*)*;base64,([A-Za-z0-9+/_-]{0,76}(\\r{0,1}\\n[ \\t>]*[A-Za-z0-9+/_-]+)*(\\\\r{0,1}\\\\{0,1}n[ \\t>]*[A-Za-z0-9+/_-]+)*[A-Za-z0-9+/_-]*={0,2})';

/** Where a data URL percent-encoded whole starts: data%3A, in any ASCII case. */
export const PERCENT_DATA_URL_SCHEME = "[dD][aA][tT][aA]%3[aA]";

/**
 * Rule (b) for a data URL percent-encoded whole. Groups: the header (mime and
 * parameters, still encoded), a header escape, the base64 run (with its
 * encoded `+`, `/` and line breaks), a run escape, the padding.
 */
export const PERCENT_DATA_URL_PATTERN =
  '[dD][aA][tT][aA]%3[aA]([^%;,:\\t\\n\\f\\r "]*(%[0-9A-Fa-f][0-9ABD-Fabd-f][^%;,:\\t\\n\\f\\r "]*)*)%3[bB]base64%2[cC]([A-Za-z0-9+/_-]*(%[02][ABDFabdf][A-Za-z0-9+/_-]*)*(%3[dD]){0,2})';

/** Rule (d): a Buffer object, `{"type": "Buffer", "data": [...]}`. */
export const BUFFER_RULE = {
  type: "Buffer",
  arrayKey: "data",
  mimeKeys: ["media_type", "mediaType", "mime_type", "mimeType"],
} as const;

/** Rule (e): a base64 string under a keyed member. */
export const KEYED_RULE = {
  keys: ["data", "b64_json", "result", "base64"],
  siblingKeys: ["media_type", "mediaType", "mime_type", "mimeType", "output_format"],
  parentKeys: ["input_audio", "audio", "inline_data", "inlineData"],
  sourceKey: "source",
  sourceType: "base64",
  blobType: "blob",
  blobKey: "content",
  /**
   * A key holding base64 whenever its object has one of the types, and, with
   * parentKeys, its object's parent key is one of them, and, with
   * holderTypes, the nearest object holding it has one of those types. With
   * keepsUrls, a URL is left to rule (b) (see keptUrl); with holderMime, the
   * mime type falls back to the enclosing object's mime keys.
   */
  typedKeys: [
    { key: "base64", types: ["image", "audio", "video", "file", "text-plain"] },
    { key: "input_audio", types: ["input_audio"] },
    { key: "inputAudio", types: ["input_audio"] },
    { key: "image", types: ["image"], keepsUrls: true },
    {
      key: "data",
      types: ["data"],
      parentKeys: ["data", "image"],
      holderTypes: ["file", "image"],
      keepsUrls: true,
      holderMime: true,
    },
  ],
  /** A URL scheme at the start of a value, as part_shapes tells a URL from base64. */
  urlScheme: "[A-Za-z][A-Za-z0-9+.-]*:",
  /** Keys holding base64 in an object under the source key, whatever its type. */
  sourceBytesKeys: ["bytes"],
  /** A member naming its object's payload base64: context for its own keys alone. */
  base64Markers: [{ key: "source_type", value: "base64", keys: ["data"] }],
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
 * The sink and the Python SDK use the same limit. The scanner recurses, and
 * from a shallow stack Node's default one ends between about 3000 levels
 * (interpreted) and 7000 (compiled); deeper in a caller's recursion it ends
 * sooner, and the value is then left as it came.
 */
const MESSAGE_MAX_DEPTH = 1000;

// --- sizes, mime types, replacements --------------------------------------------

const MIME = new RegExp(`^${MIME_PATTERN}$`);
/** Rule (b) anchored at the start of a piece: never `$`, never the g flag. */
const DATA_URL = new RegExp(`^${DATA_URL_PATTERN}`);
const ESCAPED_DATA_URL = new RegExp(`^${ESCAPED_DATA_URL_PATTERN}`);
const PERCENT_DATA_URL = new RegExp(`^${PERCENT_DATA_URL_PATTERN}`);
/** Where a rule (b) token can start: data: or data%3A, in any ASCII case. */
const DATA_SCHEME = /[dD][aA][tT][aA]:/g;
const DATA_SCHEME_START = /^[dD][aA][tT][aA]:/;
const PERCENT_SCHEME = new RegExp(PERCENT_DATA_URL_SCHEME, "g");
const PERCENT_SCHEME_START = new RegExp(`^${PERCENT_DATA_URL_SCHEME}`);

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

/** A line break written as a JSON escape, as the escaped pattern reads one. */
const ESCAPED_LINE_BREAK = /\\r{0,1}\\{0,1}n/g;

/**
 * {@link base64Size} of a base64 run `DATA_URL` or `ESCAPED_DATA_URL` matched,
 * with each escaped line break and the `>` of each quoted line it goes on over
 * removed too, from its length and padding. Once its line breaks, indent and
 * `>` are gone, the run holds nothing outside the two alphabets and at most
 * two `=`, all at its end. Only a mix of the two alphabets is left to check. A
 * run that holds no line break, raw or escaped, holds none of them.
 */
function matchedBase64Size(matched: string): number | undefined {
  const run = /[\n\\]/.test(matched)
    ? matched.replace(ESCAPED_LINE_BREAK, "").replace(/[ \t\r\n>]/g, "")
    : matched;
  if (run.length % 4 !== 0) return undefined;
  if (STANDARD_EXTRA.test(run) && URL_SAFE_EXTRA.test(run)) return undefined;
  const padding = run.endsWith("==") ? 2 : run.endsWith("=") ? 1 : 0;
  return (run.length * 3) / 4 - padding;
}

const PERCENT_ESCAPE = /%([0-9A-Fa-f]{2})/g;

/**
 * Each %XX escape as the one character (code unit) it encodes, as the
 * registry's reference decodes it: never decodeURIComponent, which reads
 * UTF-8 sequences and throws on a byte that starts none.
 */
function percentDecode(text: string): string {
  return text.replace(PERCENT_ESCAPE, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** Where a percent-encoded data URL's media type ends: its first %3B. */
const PERCENT_SEMICOLON = /%3[bB]/;

/**
 * The mime type and size of one rule (b) match. A percent-encoded one's mime
 * type is its header up to its first %3B, percent-decoded, and its run is
 * percent-decoded (%2B, %2F, %3D, and the line breaks %0A and %0D that the
 * size then drops) before it is sized. Its run can then hold characters no
 * base64 holds (%0B, %2A), so it is sized by {@link base64Size} in full.
 */
function matchToken(match: RegExpExecArray): {
  mime: string | undefined;
  byteSize: number | undefined;
} {
  if (match[0][4] === ":") {
    return { mime: isMime(match[1]) ? match[1] : undefined, byteSize: matchedBase64Size(match[3]) };
  }
  const head = percentDecode(match[1].split(PERCENT_SEMICOLON, 1)[0]);
  return { mime: isMime(head) ? head : undefined, byteSize: base64Size(percentDecode(match[3])) };
}

/** A rule (b) token in a string: its boundaries, mime type and size. */
interface DataUrlSpan {
  start: number;
  end: number;
  mime: string | undefined;
  byteSize: number | undefined;
}

/** A data URL's media type as rule (b)'s first group reads it. */
const DATA_URL_MIME = /[^;,:\t\n\f\r "]*/y;
/** What a percent-encoded header takes: a character, and an escape not ending in C. */
const PERCENT_HEADER_CHAR = /[^%;,:\t\n\f\r "]/;
const PERCENT_HEADER_ESCAPE = /^%[0-9A-Fa-f][0-9ABD-Fabd-f]$/;

/**
 * A percent-encoded data URL's media type, read by hand from `from` (just
 * past its scheme) to its first %3B, or to the first character or escape its
 * header cannot take, never past `end`: for a piece the pattern could not
 * read, so no regex that could run out of stack again.
 */
function percentMime(text: string, from: number, end: number): string | undefined {
  let i = from;
  while (i < end) {
    if (text[i] !== "%") {
      if (!PERCENT_HEADER_CHAR.test(text[i])) break;
      i++;
      continue;
    }
    const encoded = text.slice(i, Math.min(i + 3, end));
    if (!PERCENT_HEADER_ESCAPE.test(encoded) || PERCENT_SEMICOLON.test(encoded)) break;
    i += 3;
  }
  const head = percentDecode(text.slice(from, i));
  return isMime(head) ? head : undefined;
}

/**
 * A rule (b) pattern's match at the start of a piece, or undefined when it
 * holds none. Undefined too, and `failed` set, when V8's regex stack runs out
 * (from about 1.6M wrapped lines, plain or escaped, or about 2.4M percent
 * escapes): the caller then fails closed.
 */
function matchDataUrl(pattern: RegExp, piece: string): { match?: RegExpExecArray; failed?: true } {
  try {
    return { match: pattern.exec(piece) ?? undefined };
  } catch (error) {
    if (isStackOverflow(error)) return { failed: true };
    throw error;
  }
}

/** The starts of every data: and of every data%3A in a string, each in order. */
function dataUrlStarts(text: string): { plains: number[]; percents: number[] } {
  const plains = Array.from(text.matchAll(DATA_SCHEME), (m) => m.index ?? 0);
  const percents = text.includes("%")
    ? Array.from(text.matchAll(PERCENT_SCHEME), (m) => m.index ?? 0)
    : [];
  return { plains, percents };
}

/** The first of the sorted `starts` at or after `from`, else `end`. */
function firstFrom(starts: readonly number[], from: number, end: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < starts.length ? starts[lo] : end;
}

/**
 * Rule (b)'s pattern at a data: start, never past `end` (the next data:). Its
 * run (group 3), but not its header, also stops before the first data%3A at
 * or after the run's start, so a percent-encoded data URL glued after it is a
 * token of its own: the pattern is tried again at the same start, never past
 * that data%3A, through the same catch. `end` comes back as the end of the
 * slice last tried, where a token the regex stack could not read ends. A run
 * stops at %, so the retry's slice is the first one less the run's trailing
 * `data`: its overflow branch is defensive.
 */
function plainMatch(
  pattern: RegExp,
  text: string,
  start: number,
  end: number,
  percents: readonly number[],
): { match?: RegExpExecArray; failed?: true; end: number } {
  const first = matchDataUrl(pattern, text.slice(start, end));
  if (first.match === undefined) return { ...first, end };
  // The header and its parameters hold no comma: the first is ;base64,'s, so
  // this is the run's (group 3's) start.
  const runStart = start + first.match[0].indexOf(",") + 1;
  const cut = firstFrom(percents, runStart, end);
  if (cut >= start + first.match[0].length) return { ...first, end };
  return { ...matchDataUrl(pattern, text.slice(start, cut)), end: cut };
}

/**
 * Rule (b): every data URL token in a string, wherever it sits. The pattern
 * is tried at each data: (in any ASCII case) and never past the next data:,
 * so a run that goes on over a line break never takes the start of the next
 * data URL; its run, but not its header, also stops before the next data%3A
 * (see plainMatch). The percent pattern is tried at each data%3A and never
 * past the next data: or data%3A, except at a data%3A inside a plain token,
 * which can only be in its header: a plain data URL whose header holds
 * data%3A is one token. A media type that is not token/token is unknown.
 * `escaped`, for the text of a JSON candidate that does not parse, tries the
 * escaped pattern instead of the pattern, whose run also goes on over a line
 * break written as a JSON escape. When the regex stack runs out, all of the
 * slice from its scheme on is the token, its size unknown, and no data%3A
 * inside it is tried: the strip never throws, never keeps what it could not
 * read, and its tokens never overlap.
 */
function dataUrlSpans(text: string, escaped = false): DataUrlSpan[] {
  const { plains, percents } = dataUrlStarts(text);
  const plain = escaped ? ESCAPED_DATA_URL : DATA_URL;
  const spans: DataUrlSpan[] = [];
  // The end of the last plain token: a data%3A before it is not tried.
  let covered = 0;
  let i = 0;
  let j = 0;
  while (i < plains.length || j < percents.length) {
    if (j === percents.length || (i < plains.length && plains[i] < percents[j])) {
      const start = plains[i++];
      const next = i < plains.length ? plains[i] : text.length;
      const { match, failed, end } = plainMatch(plain, text, start, next, percents);
      if (failed) {
        DATA_URL_MIME.lastIndex = start + 5;
        const head = DATA_URL_MIME.exec(text)?.[0];
        spans.push({ start, end, mime: isMime(head) ? head : undefined, byteSize: undefined });
        covered = end;
      } else if (match !== undefined) {
        spans.push({ start, end: start + match[0].length, ...matchToken(match) });
        covered = start + match[0].length;
      }
      continue;
    }
    const start = percents[j++];
    if (start < covered) continue;
    const end = Math.min(
      i < plains.length ? plains[i] : text.length,
      j < percents.length ? percents[j] : text.length,
    );
    const { match, failed } = matchDataUrl(PERCENT_DATA_URL, text.slice(start, end));
    if (failed) {
      spans.push({ start, end, mime: percentMime(text, start + 7, end), byteSize: undefined });
    } else if (match !== undefined) {
      spans.push({ start, end: start + match[0].length, ...matchToken(match) });
    }
  }
  return spans;
}

/** The one final line break a whole data URL may end in: encodebytes writes one. */
const FINAL_LINE_BREAKS: readonly string[] = ["\n", "\r\n"];
/** The same line break percent-encoded, for a data URL percent-encoded whole. */
const PERCENT_FINAL_LINE_BREAKS: readonly string[] = ["%0A", "%0D%0A"];

/**
 * Rule (b)'s match when it is the whole string: the first token dataUrlSpans
 * finds, when it starts at the start and ends at the end, so with the same
 * cuts as everywhere rule (b) runs: a whole value is one rule (b) replaces
 * whole. With `lineBreak`, as a key that keeps URLs and the part rules read
 * it, the match may also end one final line break before the end (a newline,
 * or a carriage return and newline), and a percent-encoded one also one final
 * %0A or %0D%0A, its hex digits in either case. A value the regex stack
 * cannot read is no match.
 */
function wholeDataUrl(value: string, lineBreak = false): RegExpExecArray | undefined {
  const percent = PERCENT_SCHEME_START.test(value);
  if (!percent && !DATA_SCHEME_START.test(value)) return undefined;
  const { plains, percents } = dataUrlStarts(value);
  let match: RegExpExecArray | undefined;
  if (percent) {
    const end = Math.min(plains[0] ?? value.length, percents[1] ?? value.length);
    match = matchDataUrl(PERCENT_DATA_URL, value.slice(0, end)).match;
  } else {
    match = plainMatch(DATA_URL, value, 0, plains[1] ?? value.length, percents).match;
  }
  if (match === undefined) return undefined;
  const rest = value.slice(match[0].length);
  if (rest === "") return match;
  // Every line break is ASCII and at most 6 long, so no longer rest is one.
  if (!lineBreak || rest.length > 6) return undefined;
  const upper = rest.toUpperCase();
  return FINAL_LINE_BREAKS.includes(rest) || (percent && PERCENT_FINAL_LINE_BREAKS.includes(upper))
    ? match
    : undefined;
}

/** The text a media token in a raw payload is replaced by. */
export function replacement(mime: string | undefined, byteSize: number | undefined): string {
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
 * decoded value and its escapes (see {@link rawSpan}).
 */
interface JsonNode {
  start: number;
  end: number;
  members?: [string, JsonNode][];
  items?: JsonNode[];
  text?: string;
  escapes?: number[];
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
 * limit. What a value becomes is the subclass's: a tree for the strip, the
 * part spans alone for the rebuild.
 */
class Lexer {
  protected i = 0;

  constructor(
    protected readonly text: string,
    protected depth: number,
    protected readonly maxDepth: number,
  ) {}

  protected enter(): void {
    this.depth += 1;
    if (this.depth > this.maxDepth) throw new NotJson();
  }

  protected space(): void {
    while (this.i < this.text.length && " \t\n\r".includes(this.text[this.i])) this.i++;
  }

  protected expect(ch: string): void {
    if (this.text[this.i] !== ch) throw new NotJson();
    this.i++;
  }

  protected end(): void {
    this.space();
    if (this.i !== this.text.length) throw new NotJson();
  }

  /** A literal or a number. */
  protected scalar(): void {
    for (const word of LITERALS) {
      if (this.text.startsWith(word, this.i)) {
        this.i += word.length;
        return;
      }
    }
    NUMBER.lastIndex = this.i;
    const match = NUMBER.exec(this.text);
    if (match === null) throw new NotJson();
    this.i += match[0].length;
  }

  /**
   * A string, checked and passed. Decoded only when `decode` is set, a run of
   * plain characters at a time; `escapes` then gets three numbers per decoded
   * unit an escape wrote: the unit's index and the escape's raw span.
   */
  protected string(decode: boolean, escapes?: number[]): string {
    this.expect('"');
    const { text } = this;
    let out = "";
    let run = this.i;
    for (;;) {
      if (this.i >= text.length) throw new NotJson();
      const ch = text[this.i];
      if (ch === '"') break;
      if (ch < " ") throw new NotJson();
      if (ch !== "\\") {
        this.i++;
        continue;
      }
      const at = this.i;
      const kind = text.slice(at + 1, at + 2);
      let decoded: string;
      if (Object.hasOwn(SHORT_ESCAPES, kind)) {
        decoded = SHORT_ESCAPES[kind];
        this.i += 2;
      } else if (kind === "u") {
        const code = this.hex4(at + 2);
        this.i += 6;
        decoded = String.fromCharCode(code);
        if (code >= 0xd800 && code < 0xdc00 && text.startsWith("\\u", this.i)) {
          const low = this.hex4(this.i + 2);
          if (isLowSurrogate(low)) {
            this.i += 6;
            decoded = String.fromCharCode(code, low);
          }
        }
      } else {
        throw new NotJson();
      }
      if (decode) {
        out += text.slice(run, at);
        // A pair is one character in the reference, two units here: both
        // map to the whole escape pair, which no edit ever splits.
        for (let unit = 0; unit < decoded.length; unit++)
          escapes?.push(out.length + unit, at, this.i);
        out += decoded;
      }
      run = this.i;
    }
    if (decode) out += text.slice(run, this.i);
    this.i++;
    return out;
  }

  private hex4(at: number): number {
    const digits = this.text.slice(at, at + 4);
    if (!HEX4.test(digits)) throw new NotJson();
    return Number.parseInt(digits, 16);
  }
}

/** The strip's view of a candidate: every value as a {@link JsonNode}. */
class Parser extends Lexer {
  document(): JsonNode {
    this.space();
    const node = this.value();
    this.end();
    return node;
  }

  private value(): JsonNode {
    const ch = this.text[this.i];
    if (ch === "{") return this.object();
    if (ch === "[") return this.array();
    const start = this.i;
    if (ch === '"') {
      const escapes: number[] = [];
      const text = this.string(true, escapes);
      return { start, end: this.i, text, escapes };
    }
    this.scalar();
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
        const key = this.string(true);
        this.space();
        this.expect(":");
        this.space();
        members.push([key, this.value()]);
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
}

/**
 * The raw span of a string node's decoded unit: an escape's whole span, or
 * the one raw unit a plain character is, counted on from the last escape
 * before it. Only escapes are recorded, so a string costs its escapes, not a
 * span per character.
 */
function rawSpan(node: JsonNode, unit: number): [number, number] {
  const escapes = node.escapes ?? [];
  // How many escaped units come at or before this one.
  let low = 0;
  let high = escapes.length / 3;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (escapes[mid * 3] <= unit) low = mid + 1;
    else high = mid;
  }
  if (low === 0) return [node.start + 1 + unit, node.start + 2 + unit];
  const at = (low - 1) * 3;
  if (escapes[at] === unit) return [escapes[at + 1], escapes[at + 2]];
  const raw = escapes[at + 2] + (unit - escapes[at] - 1);
  return [raw, raw + 1];
}

function parse(text: string, depth: number): JsonNode | undefined {
  try {
    return new Parser(text, depth, MAX_DEPTH).document();
  } catch (error) {
    if (error instanceof NotJson) return undefined;
    throw error;
  }
}

/**
 * The spans of a message key's parts, read without a tree: the objects at
 * messages[i].parts[j] (a message's last `parts` member, as JSON.parse reads a
 * duplicated key) or, for a part list, at [j]. The whole value is checked as
 * strictly as the strip's parser checks a candidate, to MESSAGE_MAX_DEPTH, and
 * only the spans are kept, so the heap it takes is that of the parts it finds.
 */
class PartScanner extends Lexer {
  private readonly spans: [number, number][] = [];

  constructor(text: string) {
    super(text, 0, MESSAGE_MAX_DEPTH);
  }

  /** The part spans, in document order, or undefined when the value is not a list. */
  document(messages: boolean): [number, number][] | undefined {
    this.space();
    if (this.text[this.i] !== "[") return undefined;
    this.array(() => (messages ? this.message() : this.part(this.spans)));
    this.end();
    return this.spans;
  }

  private message(): void {
    if (this.text[this.i] !== "{") {
      this.skip();
      return;
    }
    let parts: [number, number][] = [];
    this.object(true, (key) => {
      if (key !== "parts") {
        this.skip();
        return;
      }
      const found: [number, number][] = [];
      if (this.text[this.i] === "[") this.array(() => this.part(found));
      else this.skip();
      parts = found;
    });
    for (const span of parts) this.spans.push(span);
  }

  private part(spans: [number, number][]): void {
    const start = this.i;
    const isObject = this.text[this.i] === "{";
    this.skip();
    if (isObject) spans.push([start, this.i]);
  }

  private skip(): void {
    const ch = this.text[this.i];
    if (ch === "{") this.object(false, () => this.skip());
    else if (ch === "[") this.array(() => this.skip());
    else if (ch === '"') this.string(false);
    else this.scalar();
  }

  private object(keys: boolean, member: (key: string) => void): void {
    this.expect("{");
    this.enter();
    this.space();
    if (this.text[this.i] === "}") {
      this.i++;
    } else {
      for (;;) {
        this.space();
        const key = this.string(keys);
        this.space();
        this.expect(":");
        this.space();
        member(key);
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
  }

  private array(item: () => void): void {
    this.expect("[");
    this.enter();
    this.space();
    if (this.text[this.i] === "]") {
      this.i++;
    } else {
      for (;;) {
        this.space();
        item();
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
  }
}

const CANDIDATE = /^[ \t\n\r]*[{[]/;

/** Starts with `{` or `[` once leading ASCII whitespace is trimmed. */
function isJsonCandidate(value: string): boolean {
  return CANDIDATE.test(value);
}

/**
 * Whether an error is the stack running out: V8's RangeError for it, or the
 * SyntaxError V8 throws when it compiles a regular expression (on its first
 * use) with no stack left. A value read where the caller's stack is already
 * deep can meet either, and is then treated as one that does not parse. Any
 * other error, a RangeError from a bug included, is not swallowed.
 */
function isStackOverflow(error: unknown): boolean {
  return (
    (error instanceof RangeError && error.message.includes("Maximum call stack size exceeded")) ||
    (error instanceof SyntaxError && error.message.endsWith("Stack overflow"))
  );
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

type TypedKey = (typeof KEYED_RULE.typedKeys)[number];

/**
 * The typed keys that hold in an object: one of its types is a type member's
 * value, the parent key is one of its parent keys, if it names any, and the
 * holder (the nearest enclosing object, as for rule (d)) has one of its
 * holder types, if it names any.
 */
function typedKeys(
  members: Members,
  parentKey: string | undefined,
  holder: Members | undefined,
): TypedKey[] {
  return KEYED_RULE.typedKeys.filter(
    (typed) =>
      (!("parentKeys" in typed) || includes(typed.parentKeys, parentKey)) &&
      (!("holderTypes" in typed) ||
        (holder !== undefined &&
          first(holder, "type", (n) => includes(typed.holderTypes, n.text)) !== undefined)) &&
      first(members, "type", (n) => includes(typed.types, n.text)) !== undefined,
  );
}

const URL_SCHEME = new RegExp(`^${KEYED_RULE.urlScheme}`);

/**
 * The keys of an object whose URL strings rule (e) leaves to rule (b): those
 * of a typed key that keeps URLs and holds in the object.
 */
function urlKeys(
  members: Members,
  parentKey: string | undefined,
  holder: Members | undefined,
): Set<string> {
  return new Set(
    typedKeys(members, parentKey, holder)
      .filter((typed) => "keepsUrls" in typed)
      .map((typed) => typed.key),
  );
}

/**
 * Whether a key that keeps URLs leaves a string to rule (b): it starts with a
 * URL scheme (base64 holds no colon, so it never does), and either it holds
 * no data: (in any ASCII case) or rule (b)'s pattern matches all of it, or all
 * of it but one final line break, so rule (b) replaces every byte (see
 * {@link urlLineBreakToken}). Any other string holding data: (a data URL whose
 * payload is percent-encoded, a broken run, a link with a data URL after it)
 * stays a rule (e) token and is replaced whole. A value that starts with
 * data%3A has no URL scheme, but it is left to rule (b) when it is one whole
 * percent-encoded data URL too.
 */
function keptUrl(value: string): boolean {
  if (PERCENT_SCHEME_START.test(value)) return wholeDataUrl(value, true) !== undefined;
  if (!URL_SCHEME.test(value)) return false;
  return !holdsDataScheme(value) || wholeDataUrl(value, true) !== undefined;
}

/** A string rule (e) replaces under `key`: a keyed string the key does not keep as a URL. */
function keyedToken(node: JsonNode, key: string, urls: Set<string>): boolean {
  return keyedString(node) && !(urls.has(key) && keptUrl(node.text ?? ""));
}

/**
 * Rule (e): the positions of the members holding base64 media, duplicates
 * included: a keyed token, or an array holding one directly. A base64 marker
 * is context for its own keys alone; `holder` is the nearest enclosing
 * object, as for rule (d).
 */
function keyedBase64(
  members: Members,
  parentKey: string | undefined,
  holder: Members | undefined,
): Set<number> {
  const rule = KEYED_RULE;
  const context =
    members.some(([k, v]) => includes(rule.siblingKeys, k) && siblingString(v)) ||
    includes(rule.parentKeys, parentKey) ||
    (parentKey === rule.sourceKey &&
      first(members, "type", isStringEqual(rule.sourceType)) !== undefined);
  const keys = new Set<string>(context ? rule.keys : []);
  for (const marker of rule.base64Markers) {
    if (first(members, marker.key, isStringEqual(marker.value)) !== undefined) {
      for (const key of marker.keys) keys.add(key);
    }
  }
  if (first(members, "type", isStringEqual(rule.blobType)) !== undefined) keys.add(rule.blobKey);
  for (const typed of typedKeys(members, parentKey, holder)) keys.add(typed.key);
  if (parentKey === rule.sourceKey) for (const key of rule.sourceBytesKeys) keys.add(key);
  const urls = urlKeys(members, parentKey, holder);
  const out = new Set<number>();
  members.forEach(([k, v], i) => {
    if (
      keys.has(k) &&
      (keyedToken(v, k, urls) || (v.items?.some((item) => keyedToken(item, k, urls)) ?? false))
    ) {
      out.add(i);
    }
  });
  return out;
}

/**
 * Rule (e)'s mime type: a mime key, else a mime format, else, when a typed
 * key that reads the holder's mime holds in the object, a mime key of
 * `holder` (the nearest enclosing object, as for rule (d)), else unknown.
 */
function keyedMime(
  members: Members,
  parentKey: string | undefined,
  holder: Members | undefined,
): string | undefined {
  const mime = mimeKey(KEYED_RULE.mimeKeys, members);
  if (mime !== undefined) return mime;
  for (const entry of KEYED_RULE.mimeFormats) {
    if ("parentKeys" in entry && !includes(entry.parentKeys, parentKey)) continue;
    const sibling = first(members, entry.key, siblingString)?.text;
    if (sibling === undefined) continue;
    const candidate = entry.mime.replace("<value>", () => sibling);
    if (isMime(candidate)) return candidate;
  }
  if (
    holder !== undefined &&
    typedKeys(members, parentKey, holder).some((t) => "holderMime" in t)
  ) {
    return mimeKey(KEYED_RULE.mimeKeys, holder);
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
 * that parses, else rule (b) alone, by the escaped pattern for a candidate
 * that does not parse (or that the stack left here cannot hold). A complete
 * replacement is left as it is.
 */
function stripText(text: string, tokens: MediaToken[], depth: number): Edit[] {
  if (isReplacement(text)) return [];
  const candidate = isJsonCandidate(text);
  if (candidate) {
    const found = tokens.length;
    try {
      const document = parse(text, depth);
      if (document !== undefined) {
        const edits: Edit[] = [];
        walk(document, undefined, undefined, depth, tokens, edits);
        return edits;
      }
    } catch (error) {
      // Out of stack, when the strip runs where the stack is already deep:
      // the candidate does not parse here, so rule (b) alone applies.
      if (!isStackOverflow(error)) throw error;
      tokens.length = found;
    }
  }
  const found = tokens.length;
  const edits: Edit[] = [];
  for (const { start, end, mime, byteSize } of dataUrlSpans(text, candidate)) {
    tokens.push({ rule: "b", mime, byteSize });
    edits.push([start, end, replacement(mime, byteSize)]);
  }
  // Rule (b) alone reads no depth, so this is what splitMedia finds. A
  // candidate is not recorded: whether it parses can depend on its depth.
  if (!candidate && recording?.has(text)) {
    recording.set(text, splitOf(text, edits, tokens.slice(found)));
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
    const keyed = keyedBase64(members, parentKey, holder);
    const mime = keyed.size > 0 ? keyedMime(members, parentKey, holder) : undefined;
    const urls = urlKeys(members, parentKey, holder);
    members.forEach(([key, child], i) => {
      if (urls.has(key) && urlLineBreakToken(child, tokens, edits)) return;
      if (!keyed.has(i) && !(urls.has(key) && child.items !== undefined)) {
        walk(child, key, members, depth + 1, tokens, edits);
      } else if (child.items === undefined) {
        replaceKeyed(child, mime, tokens, edits);
      } else {
        // A string array under the key: each string element is a token.
        for (const item of child.items) {
          if (keyed.has(i) && keyedToken(item, key, urls)) replaceKeyed(item, mime, tokens, edits);
          else if (!(urls.has(key) && urlLineBreakToken(item, tokens, edits))) {
            walk(item, key, members, depth + 2, tokens, edits);
          }
        }
      }
    });
  } else if (node.items !== undefined) {
    for (const child of node.items) walk(child, parentKey, holder, depth + 1, tokens, edits);
  } else if (node.text !== undefined) {
    // A JSON string: strip its decoded value, then map each edit back to the
    // raw characters and write it escaped for this level.
    for (const [start, end, text] of stripText(node.text, tokens, depth)) {
      const rawStart = rawSpan(node, start)[0];
      const rawEnd = end > start ? rawSpan(node, end - 1)[1] : rawStart;
      edits.push([rawStart, rawEnd, jsonEscape(text)]);
    }
  }
}

/**
 * Rule (b) on a string under a key that keeps URLs that is one data URL and
 * one final line break: the whole value, its line break included, replaced
 * inside its quotes, with the data URL's mime type and size. Rule (b)'s usual
 * span would leave the break, which a second pass would then read as rule
 * (e)'s. False, with no edit, for any other value.
 */
function urlLineBreakToken(node: JsonNode, tokens: MediaToken[], edits: Edit[]): boolean {
  if (node.text === undefined || node.text === "") return false;
  const match = wholeDataUrl(node.text, true);
  if (match === undefined || match[0].length === node.text.length) return false;
  const { mime, byteSize } = matchToken(match);
  tokens.push({ rule: "b", mime, byteSize });
  edits.push([node.start + 1, node.end - 1, jsonEscape(replacement(mime, byteSize))]);
  return true;
}

/** Rule (e) on one string literal: replaced whole, quotes included. */
function replaceKeyed(
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
export function splitMedia(text: string): TextSplit {
  const tokens: MediaToken[] = [];
  return splitOf(text, stripText(text, tokens, 0), tokens);
}

/** A text's prose bytes and its media tokens, as {@link splitMedia} returns them. */
export interface TextSplit {
  proseBytes: number;
  tokens: MediaToken[];
}

function splitOf(text: string, edits: Edit[], tokens: MediaToken[]): TextSplit {
  const written = edits.reduce((sum, [, , replaced]) => sum + Buffer.byteLength(replaced), 0);
  return { proseBytes: Buffer.byteLength(apply(text, edits)) - written, tokens };
}

/** The texts whose splits a strip records, while {@link recordSplits} runs. */
let recording: Map<string, TextSplit | undefined> | undefined;

/**
 * `run`, while every strip in it sets, for each text already a key of
 * `splits` that it strips with rule (b) alone, the split {@link splitMedia}
 * would return for that text. A text the strip reads with a JSON walk, or
 * does not reach, keeps its value. The keys are never replaced, so the map
 * holds none of the strip's own strings. The slot is shared by every strip
 * that runs inside `run`, which is safe: a recorded value depends on its text
 * alone, so whichever strip records it, the entry is the same.
 */
export function recordSplits<T>(splits: Map<string, TextSplit | undefined>, run: () => T): T {
  const previous = recording;
  recording = splits;
  try {
    return run();
  } finally {
    recording = previous;
  }
}

/**
 * A raw payload with every media token replaced in place and every other
 * character unchanged. Never throws on deep input: the parser's depth limit
 * bounds every recursion, and a candidate the stack left cannot hold gets
 * rule (b) alone.
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

/**
 * Whether a string is a data URL: it starts with data:, or with data%3A (a
 * data URL percent-encoded whole), the scheme in any ASCII case.
 */
export function isDataUrl(value: string): boolean {
  return /^[dD][aA][tT][aA]:/.test(value) || PERCENT_SCHEME_START.test(value);
}

/**
 * Whether a string holds `data:` anywhere, in any case, with no trimming and
 * no word boundary, as rule (b) finds one. A URL that holds it past its start
 * (led by whitespace, or a link followed by a data URL) is no link to keep.
 */
function holdsDataScheme(value: string): boolean {
  return /[dD][aA][tT][aA]:/.test(value);
}

/** What OpenInference writes in place of an image over its size limit. */
export const OPENINFERENCE_REDACTED = "__REDACTED__";

/**
 * A data URL as a blob: rule (b)'s pattern matching the whole URL, or all of
 * it but one final line break, is base64, with its own media type and the
 * size of its run; any other is not base64, with no size. One that holds no
 * bytes (`data:None;url,None`, what OpenInference's Anthropic instrumentor
 * writes for a url image) was emptied before we saw it, so it is redacted
 * upstream. A data URL percent-encoded whole is matched by the percent
 * pattern, its mime type and run decoded as rule (b) reads them; when it does
 * not match, it is read as any other once each %XX is decoded.
 */
export function dataUrlBlob(url: string, kind: Modality, mimeHint?: unknown): Part {
  const match = wholeDataUrl(url, true);
  if (match !== undefined) {
    const { mime, byteSize } = matchToken(match);
    return blobPart(kind, mime ?? mimeHint, byteSize, NOT_CAPTURED);
  }
  const text = url[4] === ":" ? url : percentDecode(url);
  const header = text.slice(5).split(/[;,]/, 1)[0];
  const comma = text.indexOf(",");
  const payload = comma < 0 ? "" : text.slice(comma + 1);
  const mime = isMime(header) ? header : mimeHint;
  if (payload === "" || payload === "None") {
    return blobPart(kind, mime, undefined, REDACTED_UPSTREAM);
  }
  return blobPart(kind, mime, undefined, NOT_CAPTURED);
}

/** A URL or file id the instrumentor dropped: empty, or its `__REDACTED__`. */
export function isDropped(reference: unknown): boolean {
  return reference === "" || reference === OPENINFERENCE_REDACTED;
}

/** A URL or file id that points somewhere: a string, not dropped. */
function usable(reference: unknown): string | undefined {
  return typeof reference === "string" && !isDropped(reference) ? reference : undefined;
}

/** The media a dropped URL or file id pointed to: never seen, so no size. */
export function droppedBlob(kind: Modality, mime?: unknown): Part {
  return blobPart(kind, mime, undefined, REDACTED_UPSTREAM);
}

/**
 * A provider URI as a part: a data URL is a blob, a dropped one a blob
 * redacted upstream, one that holds data: past its start (a link followed by
 * a data URL, or one led by whitespace) a blob with no size, and any other,
 * whatever its scheme, a uri. A blob's modality is the MIME type's, else
 * `kind`; a uri's the MIME type's, else `uriKind`, for a reader that takes it
 * from the URL's extension (a blob never does: it is no URL to read a path
 * from).
 */
export function urlPart(url: string, kind: Modality, mime?: unknown, uriKind = kind): Part {
  if (isDropped(url)) return droppedBlob(kind, mime);
  if (isDataUrl(url)) return dataUrlBlob(url, kind, mime);
  if (holdsDataScheme(url)) return blobPart(kind, mime, undefined, NOT_CAPTURED);
  return uriPart(uriKind, mime, url);
}

/** A provider file id as a part: a dropped one is a blob redacted upstream. */
function referencePart(fileId: string, kind: Modality, mime?: unknown): Part {
  return isDropped(fileId) ? droppedBlob(kind, mime) : fileIdPart(kind, mime, fileId);
}

/** Inline base64 (not a data URL) as a blob. */
export function base64Blob(data: string, kind: Modality, mime: unknown): Part {
  if (isDataUrl(data)) return dataUrlBlob(data, kind, mime);
  return blobPart(kind, mime, base64Size(data), NOT_CAPTURED);
}

export const EXTENSION_MODALITY: Readonly<Record<string, Modality>> = {
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
export function uriModality(uri: string): Modality {
  const path = uri.split("#", 1)[0].split("?", 1)[0];
  return filenameModality(path.slice(path.lastIndexOf("/") + 1));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * A LangChain v1 standard content block's type, when it carries base64, and
 * the modality it names. A file or text-plain block names none, so it is a
 * document unless its MIME type (or, for a file by URL, the URL's extension)
 * says otherwise.
 */
const LANGCHAIN_KINDS: Readonly<Record<string, Modality>> = {
  image: "image",
  audio: "audio",
  video: "video",
  file: "document",
  "text-plain": "document",
};

/** The LangChain v1 block types whose url or file_id is a reference to media. */
const LANGCHAIN_REFERENCE_TYPES: readonly string[] = ["image", "audio", "video", "file"];

/**
 * A LangChain v1 standard content block as one part, by the first of:
 * (1) a file block with a usable file_id is a native file part; (2) base64 is
 * a blob; (3) a usable file_id a file; (4) a usable url a uri (a blob when it
 * is a data URL); (5) a file block whose file_id is a string, with nothing
 * else usable, a native file part, its file_id kept as written; (6) a url or
 * file_id that is a string but dropped, a blob redacted upstream. A usable
 * reference (base64 included) always wins over a dropped one. Only type,
 * base64, url, file_id and mime_type are read, but for the native file parts,
 * which keep a valid modality member first; so a v0 url block is read the
 * same way and a v0 base64 or id block holds none of them. Undefined for any
 * other block, which stays as it came (an Anthropic image or document, an
 * OpenAI file).
 */
function langchainPart(item: Record<string, unknown>): Part[] | undefined {
  const type = item.type;
  if (typeof type !== "string" || !Object.hasOwn(LANGCHAIN_KINDS, type)) return undefined;
  const fileId = usable(item.file_id);
  if (type === "file" && fileId !== undefined) return nativeFilePart(item);
  const kind = LANGCHAIN_KINDS[type] as Modality;
  const mime = item.mime_type;
  // Beside a file block's string file_id, an empty or redacted base64 points
  // nowhere, so the block reads on; anywhere else it is a bare payload.
  const droppedBase64 =
    type === "file" && typeof item.file_id === "string" && isDropped(item.base64);
  if (typeof item.base64 === "string" && !droppedBase64) {
    return [base64Blob(item.base64, kind, mime)];
  }
  if (!LANGCHAIN_REFERENCE_TYPES.includes(type)) return undefined;
  if (fileId !== undefined) return [fileIdPart(kind, mime, fileId)];
  const url = usable(item.url);
  if (url !== undefined) {
    if (isDataUrl(url)) return [dataUrlBlob(url, kind, mime)];
    if (holdsDataScheme(url)) return [blobPart(kind, mime, undefined, NOT_CAPTURED)];
    // A file names no modality: a link's extension does, before document.
    return [uriPart(type === "file" ? uriModality(url) : kind, mime, url)];
  }
  if (type === "file" && typeof item.file_id === "string") return nativeFilePart(item);
  if (typeof item.url === "string" || typeof item.file_id === "string") {
    return [droppedBlob(kind, mime)];
  }
  return undefined;
}

/** The part kind's modality, for a part with no MIME type. */
function kindModality(type: unknown): Modality {
  return type === "image" ? "image" : "document";
}

/**
 * A provider's media content item as semconv parts, or undefined when it is
 * not a media item this module knows (it then passes through unchanged as a
 * generic part). Covers the pass-through rows of the mapping table: OpenAI
 * chat and Responses, Anthropic, Gemini, Mistral, LangChain v1, Bedrock
 * Converse, and native semconv media parts.
 */
export function providerMediaParts(item: unknown): Part[] | undefined {
  if (!isRecord(item)) return undefined;
  const langchain = langchainPart(item);
  if (langchain !== undefined) return langchain;
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
      // Mistral's TypeScript SDK spells it inputAudio.
      const audio =
        typeof item.input_audio !== "string" && typeof item.inputAudio === "string"
          ? item.inputAudio
          : item.input_audio;
      // Mistral's audio chunk: the bare base64, with no format.
      if (typeof audio === "string") return [base64Blob(audio, "audio", undefined)];
      if (!isRecord(audio) || typeof audio.data !== "string") return undefined;
      const format = asString(audio.format);
      return [base64Blob(audio.data, "audio", format && `audio/${format}`)];
    }
    case "input_image": {
      const url = usable(item.image_url);
      if (url !== undefined) return [urlPart(url, "image")];
      const fileId = usable(item.file_id);
      if (fileId !== undefined) return [fileIdPart("image", undefined, fileId)];
      if (typeof item.image_url === "string" || typeof item.file_id === "string") {
        return [droppedBlob("image")];
      }
      return undefined;
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
      return (item.type === undefined ? bedrockPart(item) : undefined) ?? geminiPart(item);
  }
}

/**
 * A Bedrock Converse image, video, audio or document block, which has no
 * type, by its source's bytes: base64 (or, from the AWS SDK, a Uint8Array) is
 * a blob. An image's format names its mime type; a video, audio or document
 * format is not always a MIME subtype, so it names none.
 */
function bedrockPart(item: Record<string, unknown>): Part[] | undefined {
  for (const kind of ["image", "video", "audio", "document"] as const) {
    const block = item[kind];
    if (!isRecord(block)) continue;
    const data = isRecord(block.source) ? block.source.bytes : undefined;
    const format = kind === "image" ? asString(block.format) : undefined;
    const mime = format && `image/${format}`;
    if (typeof data === "string") return [base64Blob(data, kind, mime)];
    if (data instanceof Uint8Array) return [blobPart(kind, mime, data.length, NOT_CAPTURED)];
  }
  return undefined;
}

/**
 * OpenAI's file item: chat's `file {file_id | file_data, filename}` or the
 * Responses `input_file {file_id | file_data | file_url, filename}`. File data
 * is a data URL (its mime type names the modality) or bare base64, whose
 * modality comes from the filename. With no usable reference (each one
 * missing, not a string, empty or redacted), it was dropped upstream: never a
 * part of type file without a file_id.
 */
function openaiFile(file: Record<string, unknown>): Part[] {
  const kind = filenameModality(file.filename);
  const fileId = usable(file.file_id);
  if (fileId !== undefined) return [fileIdPart(kind, undefined, fileId)];
  const data = usable(file.file_data);
  if (data !== undefined) return [base64Blob(data, kind, undefined)];
  const url = usable(file.file_url);
  if (url !== undefined) return [urlPart(url, kind)];
  return [droppedBlob(kind)];
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
        ? [referencePart(source.file_id, kind, source.media_type)]
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
 * (a blob when its URI is a data URL or holds one past its start).
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
      return [urlPart(uri, "document", file.mime_type ?? file.mimeType, uriModality(uri))];
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
 * uri, and so is one holding data: past its start, with no size. A file
 * part holding a string base64 or url is a LangChain v1 file block and is
 * read as one (see langchainPart). Undefined when it is not a media part
 * this can read, which stays as it came.
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
      if (holdsDataScheme(part.uri)) return [blobPart(kind, mime, undefined, NOT_CAPTURED)];
      const out = shaped("uri", uriModality(part.uri));
      out.uri = part.uri;
      return [out];
    }
    case "file":
      // A string base64 or url makes it a LangChain v1 file block, on every path.
      if (typeof part.base64 === "string" || typeof part.url === "string") {
        return langchainPart(part);
      }
      return nativeFilePart(part);
    default:
      return undefined;
  }
}

/** A native file part by its string file_id; undefined when it has none. */
function nativeFilePart(part: Record<string, unknown>): Part[] | undefined {
  if (typeof part.file_id !== "string") return undefined;
  const own = typeof part.modality === "string" && MODALITIES.includes(part.modality);
  const out: Part = {
    type: "file",
    modality: own ? (part.modality as Modality) : (modalityOf(part.mime_type) ?? "document"),
  };
  if (isMime(part.mime_type)) out.mime_type = part.mime_type;
  out.file_id = part.file_id;
  return [out];
}

/** The part spans of a message key, or undefined when it does not parse or is no list. */
function partSpans(text: string, messages: boolean): [number, number][] | undefined {
  try {
    return new PartScanner(text).document(messages);
  } catch (error) {
    if (error instanceof NotJson) return undefined;
    throw error;
  }
}

/**
 * A message key's native media parts rebuilt in place (see nativeMediaPart):
 * each part whose canonical encoding differs from its bytes is replaced by
 * it, compact, several parts comma-separated, and every other byte is kept as
 * it came. `messages` is a list of messages, each with its `parts` (the
 * last, as JSON.parse reads a duplicated key); otherwise the list is the
 * parts themselves, as system instructions are. A value that does not parse
 * (or that the stack left to it cannot hold) is returned as it came.
 * Canonical parts hold only token/token MIME types, numbers and the
 * producer's strings, which JSON.stringify escapes as minimally as the strip
 * does. `toParts` is nativeMediaPart, injectable for tests.
 */
export function rebuildNativeMediaParts(
  text: string,
  messages: boolean,
  toParts: (part: Record<string, unknown>) => Part[] | undefined = nativeMediaPart,
): string {
  try {
    if (!isJsonCandidate(text)) return text;
    const spans = partSpans(text, messages);
    if (spans === undefined) return text;
    const edits: Edit[] = [];
    for (const [start, end] of spans) {
      const source = text.slice(start, end);
      // Read as JSON.parse reads it: the last of a duplicated key wins.
      const media = toParts(JSON.parse(source));
      // No parts at all would leave `[a,,b]`: the part stays as it came.
      if (media === undefined || media.length === 0) continue;
      const encoded = media.map((part) => JSON.stringify(part)).join(",");
      if (encoded !== source) edits.push([start, end, encoded]);
    }
    return edits.length > 0 ? apply(text, edits) : text;
  } catch (error) {
    // Out of stack, when the rebuild runs where the stack is already deep:
    // the value does not parse here, and is left as it came.
    if (isStackOverflow(error)) return text;
    throw error;
  }
}
