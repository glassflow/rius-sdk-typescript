import {
  type Attributes,
  type AttributeValue,
  type Context,
  SpanStatusCode,
} from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { moveAggregatedUsage, moveWrappedCallUsage, noteWrapperStart } from "./aggregatedUsage.js";
import { qualifyRecordedExceptions } from "./errorType.js";
import {
  base64Blob,
  blobPart,
  NOT_CAPTURED,
  OPENINFERENCE_REDACTED,
  REDACTED_UPSTREAM,
  rebuildNativeMediaParts,
  stripRawPayload,
  uriPart,
  urlPart,
} from "./mediaParts.js";
import {
  ERROR_TYPE,
  EXCEPTION_EVENT,
  EXCEPTION_TYPE,
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OPERATION_NAME,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_CHOICE_COUNT,
  GEN_AI_REQUEST_ENCODING_FORMATS,
  GEN_AI_REQUEST_FREQUENCY_PENALTY,
  GEN_AI_REQUEST_MAX_TOKENS,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_REQUEST_PRESENCE_PENALTY,
  GEN_AI_REQUEST_PREVIOUS_RESPONSE_ID,
  GEN_AI_REQUEST_REASONING_LEVEL,
  GEN_AI_REQUEST_SEED,
  GEN_AI_REQUEST_STOP_SEQUENCES,
  GEN_AI_REQUEST_STREAM,
  GEN_AI_REQUEST_STREAM_CURSOR,
  GEN_AI_REQUEST_TEMPERATURE,
  GEN_AI_REQUEST_TOP_K,
  GEN_AI_REQUEST_TOP_P,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_RESPONSE_ID,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_DEFINITIONS,
  GEN_AI_TOOL_NAME,
  GEN_AI_TOOL_TYPE,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_PREFIX,
  GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  INVOCATION_PARAMETERS_CONTENT_MEMBERS,
  kindForOperation,
  LLM_INPUT_MESSAGES_PREFIX,
  LLM_INVOCATION_PARAMETERS,
  LLM_MESSAGE_CONTENT,
  LLM_MESSAGE_CONTENT_PREFIX,
  LLM_MESSAGE_CONTENTS_PREFIX,
  LLM_MESSAGE_ROLE,
  LLM_MESSAGE_TOOL_CALL_ID,
  LLM_MESSAGE_TOOL_CALLS_PREFIX,
  LLM_OUTPUT_MESSAGES_PREFIX,
  LLM_TOOL_CALL_FUNCTION_ARGUMENTS,
  LLM_TOOL_CALL_FUNCTION_NAME,
  LLM_TOOL_CALL_ID,
  LLM_TOOL_CALL_PREFIX,
  OPENINFERENCE_SPAN_KIND,
  OUTPUT_VALUE,
  operationForKind,
  RIUS_AGGREGATED_USAGE_PREFIX,
  RIUS_REQUEST_TOOL_CHOICE,
  SpanKind,
} from "./semconv.js";
import { toAttributeValue } from "./serde.js";

/**
 * Normalization: third-party attribute dialects rewritten to the conventions
 * this SDK emits natively, before anything else in the pipeline looks at them.
 *
 * Every instrumentation in the ecosystem spells the same facts differently —
 * OpenInference, the Vercel AI SDK and OpenLLMetry each have their own name for
 * the request model and the prompt token count. The backend should not have to
 * know all of them, and neither should the rest of this SDK: masking, pending
 * snapshots and context sizes all key on canonical names. So one component maps
 * the dialects once, at the edge, and everything downstream sees one vocabulary.
 *
 * This module is the SKELETON: the mapping mechanism, the contract rules and
 * the converters. The shipped table is EMPTY, deliberately — see
 * NORMALIZATION_RULES. The real tables (OpenInference, Vercel, OpenLLMetry)
 * are separate tickets.
 *
 * Kept deliberately structural so the Python SDK's table can stay in lockstep
 * with this one: rules are DATA (source key, target key, converter), never
 * per-instrumentor code, and the converter set is closed and named.
 */

/**
 * Turns the present source values into the canonical value, or `undefined`
 * when it cannot: an unparseable payload or an absent JSON member is not a
 * mapping failure to paper over, it means the rule does not apply.
 *
 * Receives the values of the rule's source keys THAT ARE PRESENT, in the
 * rule's own source order. Single-source converters read `values[0]`.
 */
export type Converter = (values: readonly AttributeValue[]) => AttributeValue | undefined;

/**
 * Everything a span should carry IN PLACE OF an expanding rule's source: the
 * canonical keys the source's contents produced, and optionally the source
 * key itself holding whatever nothing claimed.
 */
export type Expansion = Record<string, AttributeValue | undefined>;

/**
 * Turns one source value into the whole set of keys that replaces it. `read`
 * holds the values of the rule's `reads` keys that the span carries.
 */
export type Expander = (
  raw: AttributeValue | undefined,
  read: Readonly<Record<string, AttributeValue>>,
) => Expansion;

/**
 * One mapping. `identity` marks a rule whose source is knowable at span START
 * (a model name, a tool name) and which therefore also runs in `onStart`, so
 * pending snapshots — built from an allowlist of CANONICAL identity keys —
 * see the canonical spelling rather than the dialect.
 */
export interface MappingRule {
  /** Source key, or several for a converter that combines them (see `sum`). */
  readonly source: string | readonly string[];
  readonly target: string;
  readonly convert: Converter;
  readonly identity?: boolean;
}

/**
 * One source key that fans out over SEVERAL canonical keys, for a source that
 * is a bag rather than a value.
 *
 * A {@link MappingRule} cannot express it: it has one target, and the generic
 * delete would take the whole bag away for the sake of one member.
 *
 * `expand` receives the raw source value and returns EVERYTHING the span
 * should carry in its place. That may include THE SOURCE KEY ITSELF, which is
 * the single exemption from both native-wins and delete-the-source: a rule
 * rewriting its own input is not competing with an instrumentation that
 * already speaks the convention.
 *
 * That exemption is not a nicety here. This SDK sets
 * `openinference.span.kind` on every span it emits, so the taxonomy rules
 * match all of them; without the exemption the generic delete would strip
 * that key from every native span, which is data loss rather than a
 * normalization quirk.
 */
export interface ExpandingRule {
  readonly source: string;
  readonly expand: Expander;
  readonly identity?: boolean;
  /**
   * Other keys the expansion depends on without consuming them: they are not
   * sources, so they are never deleted. Handed to `expand` as `read`.
   */
  readonly reads?: readonly string[];
}

/** A rule of either shape. Both expose `source`. */
export type NormalizationRule = MappingRule | ExpandingRule;

function isExpanding(rule: NormalizationRule): rule is ExpandingRule {
  return "expand" in rule;
}

// --- Converters ---

/** The value unchanged. The common case: the same fact under another name. */
export const copy: Converter = (values) => values[0];

/**
 * A count that arrived as a string. Instrumentations that build attributes
 * from JSON routinely emit token counts as strings; the conventions type them
 * as int, and the backend sums them. A non-integral or unparseable value maps
 * to nothing rather than to a wrong number.
 */
export const toInt: Converter = (values) => {
  const value = values[0];
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

/**
 * A scalar the conventions type as a list — `gen_ai.response.finish_reasons`
 * is the standing example: producers emit one reason, the convention is an
 * array. An array already is one; anything else is left alone.
 */
export const wrapInList: Converter = (values) => {
  const value = values[0];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  if (typeof value === "number") return [value];
  if (typeof value === "boolean") return [value];
  return undefined;
};

/**
 * Promotes one member out of a JSON blob into its own attribute — the shape
 * the Vercel AI SDK uses for `ai.prompt`, where the messages the conventions
 * want as their own attribute sit inside a wrapper object.
 *
 * Objects and arrays come back re-serialized (attribute values are scalars or
 * scalar arrays; a nested structure has to stay JSON), primitives come back as
 * themselves. An absent member or an unparseable blob yields `undefined`, so
 * the rule does not fire and the source survives untouched.
 */
export function jsonMember(member: string): Converter {
  return (values) => {
    const raw = values[0];
    if (typeof raw !== "string") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>)[member];
    if (value === undefined || value === null) return undefined;
    if (typeof value === "object") return JSON.stringify(value);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    return undefined;
  };
}

/**
 * Adds the present source values. Some dialects split a count the conventions
 * keep whole (cached prompt tokens reported beside uncached ones). Sums only
 * what is there, so a rule still fires when one part is missing; a
 * non-numeric part makes the whole sum untrustworthy, so it yields nothing.
 */
export const sum: Converter = (values) => {
  let total = 0;
  for (const value of values) {
    const part = toInt([value]);
    if (typeof part !== "number") return undefined;
    total += part;
  }
  return values.length === 0 ? undefined : total;
};

// --- The table ---

// --- OpenInference (openai, anthropic, langchain, llama-index, litellm) ---
//
// Source spellings were read from the instrumentors installed at the pinned
// peer versions, not from memory. Note that each instrumentor NESTS its own
// copy of @arizeai/openinference-semantic-conventions: the hoisted 2.7.0 has
// no llm.request.model_name / llm.response.model_name, while the 2.8.0 nested
// under the anthropic and openai instrumentations does, and that is the one
// they compile against. Read the nested copy or a rule looks dead when it is
// not.

/**
 * Provider spellings the GenAI registry writes differently from the source.
 *
 * Two dialects feed `gen_ai.provider.name` and both carry values the registry
 * renamed. The pairs come from the registry itself: its `GenAiSystemValues`
 * members carry "Deprecated: Replaced by X" docstrings, and
 * `GenAiProviderNameValues` spells xAI `x_ai` and Mistral `mistral_ai`
 * against OpenInference's `xai` / `mistralai`.
 *
 * Only renames of the SAME provider are listed. OpenInference's `azure`,
 * `aws` and `google` are deliberately NOT translated: each covers several
 * registry values (`azure.ai.openai` vs `azure.ai.inference`, `aws.bedrock`
 * vs the rest of AWS, three `gcp.*`), so a translation would be a guess. They
 * pass through verbatim, which is allowed — the attribute's values are
 * "well-known", not closed, and the langchain instrumentation already
 * forwards any `ls_provider` string it is handed.
 */
export const PROVIDER_NAME_ALIASES: Readonly<Record<string, string>> = {
  // OpenInference enum values
  mistralai: "mistral_ai",
  xai: "x_ai",
  vertexai: "gcp.vertex_ai",
  // legacy gen_ai.system values
  vertex_ai: "gcp.vertex_ai",
  gemini: "gcp.gemini",
  "az.ai.inference": "azure.ai.inference",
  "az.ai.openai": "azure.ai.openai",
};

/** The provider, under the registry's spelling where it differs. */
export const providerName: Converter = (values) => {
  const value = values[0];
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase();
  return Object.hasOwn(PROVIDER_NAME_ALIASES, key) ? PROVIDER_NAME_ALIASES[key] : value;
};

/**
 * The model without a leading `<provider>/` that names the span's own provider.
 *
 * LiteLLM routes on a prefix (`openai/gpt-4o-mini`) and its instrumentation
 * records the model exactly as passed, so the same model would otherwise carry
 * two names depending on whether LiteLLM was in the path. The prefix is dropped
 * only when it IS the provider (compared under the registry's spelling, so
 * `vertex_ai/...` matches `gcp.vertex_ai`): then it says nothing
 * gen_ai.provider.name does not, and the routed string can be rebuilt from the
 * two. Any other prefix is part of the name, as in
 * `openai/google/gemini-2.5-flash` routed through an OpenAI-compatible
 * gateway, and stays.
 */
export function withoutProviderRoute(model: string, provider: AttributeValue | undefined): string {
  if (typeof provider !== "string" || provider === "") return model;
  const slash = model.indexOf("/");
  if (slash === -1 || slash === model.length - 1) return model;
  if (providerName([model.slice(0, slash)]) !== provider) return model;
  return model.slice(slash + 1);
}

/**
 * OpenInference's name for the API a client speaks. A source spelling, like
 * gen_ai.system: mapped, never emitted, so it is spelled here rather than in
 * semconv.ts.
 */
const LLM_SYSTEM = "llm.system";

/**
 * `llm.system` kept, plus the provider it implies.
 *
 * The fallback for a span with no llm.provider: an OpenAI client pointed at a
 * gateway, whose host the instrumentation does not recognize. The registry
 * defines the provider as the instrumentation's best knowledge, allowed to
 * differ from whoever served the request behind a proxy, and as the
 * discriminator for the telemetry flavor; the API the client speaks is both.
 *
 * Kept rather than consumed: on Azure llm.system (openai) differs from
 * llm.provider (azure), so it is a fact of its own, not a duplicate.
 */
export function providerFromSystem(raw: AttributeValue | undefined): Expansion {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  const produced: Expansion = { [LLM_SYSTEM]: raw };
  const provider = providerName([raw]);
  if (provider !== undefined) produced[GEN_AI_PROVIDER_NAME] = provider;
  return produced;
}

/** A double, or nothing. Booleans are not numbers here. */
function asNumber(value: unknown): AttributeValue | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** An integer, or nothing. */
function asCount(value: unknown): AttributeValue | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

/**
 * {@link asCount}, with a negative value read as "not configured": LlamaIndex
 * writes `num_output: -1` when the request sets no output budget, and that is
 * no value, not a budget of -1.
 */
function asConfiguredCount(value: unknown): AttributeValue | undefined {
  const count = asCount(value);
  return count === undefined || (count as number) < 0 ? undefined : count;
}

/** Two converted attribute values are the same value (arrays element-wise). */
function sameValue(a: AttributeValue | undefined, b: AttributeValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => item === b[i]);
  }
  return a !== undefined && a === b;
}

/** A non-empty string, or nothing. */
function asText(value: unknown): AttributeValue | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The source as a non-empty string, or nothing: a name that is not a name maps to nothing. */
export const textValue: Converter = (values) => asText(values[0]);

/** A boolean, or nothing. */
function asFlag(value: unknown): AttributeValue | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** A string list. A lone stop string is the one-element list of itself. */
function asTextList(value: unknown): AttributeValue | undefined {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return [...value];
  return undefined;
}

/** A UTF-16 surrogate with no partner. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** `text` with every unpaired surrogate replaced by U+FFFD, as Go's encoder does. */
function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, "\ufffd");
}

/**
 * One JSON string literal in the encoding the sink shares with this SDK and
 * the Python one (the sink's `jsonenc`): raw UTF-8, no HTML escaping, U+2028
 * and U+2029 left RAW, an unpaired surrogate replaced with U+FFFD. Everything
 * else is `JSON.stringify`'s escaping, which already agrees: the short escapes
 * (`\b \f \n \r \t`), `\u00XX` for the other control characters, and `/`
 * unescaped.
 */
function jsonString(text: string): string {
  return JSON.stringify(wellFormed(text));
}

/**
 * `value` (parsed JSON) as compact JSON in raw UTF-8, member order kept.
 *
 * Written out rather than left to `JSON.stringify`, because the result is
 * matched byte for byte: the sink promotes the same member from the same bag
 * and the Python SDK writes the same string. `JSON.stringify` alone would
 * escape an unpaired surrogate as `\udXXX` text, where the sink replaces it
 * with U+FFFD, in keys as well as values.
 *
 * Known, accepted divergence, shared with the Python SDK: numbers are
 * re-spelled from the parsed value (`1e2` becomes `100`, `-0` becomes `0`)
 * where the sink keeps the literal, and a duplicate member name keeps only
 * its last value. No provider sends numeric or duplicated `tool_choice`
 * members.
 */
function compactJson(value: unknown): string {
  if (typeof value === "string") return jsonString(value);
  if (Array.isArray(value)) return `[${value.map(compactJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const members = Object.entries(value).map(([k, v]) => `${jsonString(k)}:${compactJson(v)}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * A mode kept as the non-empty string it is, or an object as compact JSON:
 * the two shapes a provider's `tool_choice` takes. Any other shape is not one
 * we can vouch for, so it stays in the bag.
 */
function asToolChoice(value: unknown): AttributeValue | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return compactJson(value);
  }
  // A mode is written as the attribute itself, not as JSON, so it gets the
  // same U+FFFD replacement the object path applies; a lone surrogate would
  // otherwise leave the SDK as the sink never writes it.
  return typeof value === "string" ? asText(wellFormed(value)) : undefined;
}

/**
 * Members of `llm.invocation_parameters` that a canonical key (a
 * `gen_ai.request.*` key, or `rius.request.tool_choice`) represents TOTALLY,
 * in precedence order: the first spelling to produce a
 * target keeps it. Everything else stays in the bag — see
 * {@link invocationParameters} for why that is deliberate.
 *
 * The per-member guard is part of the contract, not defensive coding: a
 * member whose value is the wrong shape is NOT promoted and stays where it
 * was, so a canonical key never carries a value of the wrong type.
 */
export const INVOCATION_PARAMETER_MEMBERS: ReadonlyArray<
  readonly [string, string, (value: unknown) => AttributeValue | undefined]
> = [
  // Every instrumentation but the anthropic one keeps `model` in the bag, and
  // it is the literal request field — unlike llm.model_name, see the
  // omissions below.
  ["model", GEN_AI_REQUEST_MODEL, asText],
  // LlamaIndex fills the bag with the model's metadata, not the request's
  // parameters, and names the model `model_name` there. LangChain's bag has
  // `model_name` too, next to `model` with the same value; listed after
  // `model`, it is promoted only where `model` is absent.
  ["model_name", GEN_AI_REQUEST_MODEL, asText],
  ["temperature", GEN_AI_REQUEST_TEMPERATURE, asNumber],
  ["top_p", GEN_AI_REQUEST_TOP_P, asNumber],
  ["top_k", GEN_AI_REQUEST_TOP_K, asCount],
  ["max_tokens", GEN_AI_REQUEST_MAX_TOKENS, asCount],
  // OpenAI's replacement for max_tokens on the reasoning models: "an upper
  // bound for the number of tokens that can be generated for a completion",
  // which is what gen_ai.request.max_tokens means. Listed second so a request
  // carrying both keeps the one the provider would honour.
  ["max_completion_tokens", GEN_AI_REQUEST_MAX_TOKENS, asCount],
  // LlamaIndex's metadata spelling of the same setting: the number of tokens
  // the model is configured to generate, -1 when nothing is.
  ["num_output", GEN_AI_REQUEST_MAX_TOKENS, asConfiguredCount],
  ["frequency_penalty", GEN_AI_REQUEST_FREQUENCY_PENALTY, asNumber],
  ["presence_penalty", GEN_AI_REQUEST_PRESENCE_PENALTY, asNumber],
  ["seed", GEN_AI_REQUEST_SEED, asCount],
  ["n", GEN_AI_REQUEST_CHOICE_COUNT, asCount],
  ["stop", GEN_AI_REQUEST_STOP_SEQUENCES, asTextList],
  ["stop_sequences", GEN_AI_REQUEST_STOP_SEQUENCES, asTextList],
  ["stream", GEN_AI_REQUEST_STREAM, asFlag],
  // Not a convention key: the GenAI conventions define no tool_choice, so it
  // goes where an unnamed request parameter goes, rius.request.*. Promoted
  // because context attribution reads it to tell a forced tool call from an
  // automatic one, and the bag is content: left inside, it goes wherever
  // masking sends the bag. It is a routing parameter, not content, and this
  // runs before masking.
  ["tool_choice", RIUS_REQUEST_TOOL_CHOICE, asToolChoice],
];

/**
 * The guard for every canonical `gen_ai.request.*` key, by the key's type in
 * the GenAI registry: the value to record, or `undefined` when the value is
 * the wrong shape for that key. The native `modelParameters` path
 * (`requestAttributes` in generation.ts) and the members above use the SAME
 * function per key, so one parameter has one shape on the wire whichever way
 * it arrived; a test pins that the two stay wired to this table.
 */
export const REQUEST_PARAMETER_GUARDS: Readonly<
  Record<string, (value: unknown) => AttributeValue | undefined>
> = {
  [GEN_AI_REQUEST_MODEL]: asText, // string
  [GEN_AI_REQUEST_MAX_TOKENS]: asCount, // int
  [GEN_AI_REQUEST_CHOICE_COUNT]: asCount, // int
  [GEN_AI_REQUEST_TEMPERATURE]: asNumber, // double
  [GEN_AI_REQUEST_TOP_P]: asNumber, // double
  [GEN_AI_REQUEST_TOP_K]: asCount, // int
  [GEN_AI_REQUEST_STOP_SEQUENCES]: asTextList, // string[]
  [GEN_AI_REQUEST_FREQUENCY_PENALTY]: asNumber, // double
  [GEN_AI_REQUEST_PRESENCE_PENALTY]: asNumber, // double
  [GEN_AI_REQUEST_ENCODING_FORMATS]: asTextList, // string[]
  [GEN_AI_REQUEST_SEED]: asCount, // int
  [GEN_AI_REQUEST_STREAM]: asFlag, // boolean
  [GEN_AI_REQUEST_REASONING_LEVEL]: asText, // string
  [GEN_AI_REQUEST_PREVIOUS_RESPONSE_ID]: asText, // string
  [GEN_AI_REQUEST_STREAM_CURSOR]: asText, // string
};

/**
 * OpenInference's run-metadata attribute. Read to recognise a LangChain run,
 * never emitted, so spelled here rather than in semconv.ts.
 */
const METADATA = "metadata";

/**
 * The prefix LangChain gives its own run-metadata keys (ls_provider,
 * ls_model_name, ls_integration, ...), in both its Python and JS releases.
 */
const LANGCHAIN_METADATA_PREFIX = "ls_";

/**
 * True when the bag came from a LangChain model object. The Python
 * integration marks its bag with LangChain's `_type`; the JS one does not, but
 * both write LangChain's `ls_*` keys into the run metadata.
 */
function isLangChainRun(
  payload: Readonly<Record<string, unknown>>,
  read: Readonly<Record<string, AttributeValue>>,
): boolean {
  if (Object.hasOwn(payload, "_type")) return true;
  const raw = read[METADATA];
  if (typeof raw !== "string") return false;
  let metadata: unknown;
  try {
    metadata = JSON.parse(raw);
  } catch {
    return false;
  }
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return Object.keys(metadata).some((key) => key.startsWith(LANGCHAIN_METADATA_PREFIX));
}

/**
 * The provider LangChain names in the run metadata's `ls_provider`, through
 * the same spellings as llm.provider, which the Python LangChain
 * instrumentation fills from this very key. It is the chat model class's own
 * name for the API it calls (`openai` for `ChatOpenAI`, also behind a
 * gateway).
 */
function langchainProvider(
  read: Readonly<Record<string, AttributeValue>>,
): AttributeValue | undefined {
  const raw = read[METADATA];
  if (typeof raw !== "string") return undefined;
  let metadata: unknown;
  try {
    metadata = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const named = (metadata as Record<string, unknown>).ls_provider;
  if (typeof named !== "string" || named.trim() === "") return undefined;
  return providerName([named]);
}

/**
 * Promote the spec-defined members of the request bag; keep the rest.
 *
 * The leftover members go back under `llm.invocation_parameters`, and that is
 * deliberate rather than a half-measure. The bag's membership is open and
 * provider-defined: the litellm and langchain instrumentations leave the
 * request's `tools` / `functions` arrays in it, which is why the whole bag is
 * content (semconv.ts). Fanning unknown members out into keys of our own would
 * move content out from under that and past `captureContent: false`.
 * So a member is promoted only when a canonical key represents it totally,
 * and the bag survives to carry everything else. A bag left empty is dropped
 * rather than kept as `{}`.
 *
 * There is deliberately no `rius.request.<key>` catch-all: that namespace is
 * filled natively and normalization was never meant to populate it. The one
 * member it does take is `tool_choice`, because attribution reads it and it
 * must not go with the bag when content capture is off.
 *
 * A member that produced a canonical key leaves the bag even when a native
 * key beat it — at that point it is a duplicate, which is the same reason a
 * mapped source key is deleted.
 *
 * LangChain's `stream` member is never promoted. LangChain serializes the
 * model object's settings into the bag, so `stream` is the model's default,
 * not what the call did: a `ChatOpenAI.stream()` call records `false` there.
 * An absent key is honest; that one is not. `read` holds the span's run
 * metadata, which identifies a LangChain run.
 *
 * A LangChain run also gets its provider from that metadata (`ls_provider`).
 * The JS instrumentation records no provider key at all, so this is the only
 * place a Node LangChain span can get one. The provider rules come earlier in
 * the table and win, so llm.provider (which the Python instrumentation copies
 * from `ls_provider`) and llm.system keep precedence, and a native
 * gen_ai.provider.name wins as always.
 */
export function invocationParameters(
  raw: AttributeValue | undefined,
  read: Readonly<Record<string, AttributeValue>> = {},
): Expansion {
  if (typeof raw !== "string") return { [LLM_INVOCATION_PARAMETERS]: raw };
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Unreadable is exactly when a pass-through is right: the caller's value
    // is the only record of it.
    return { [LLM_INVOCATION_PARAMETERS]: raw };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { [LLM_INVOCATION_PARAMETERS]: raw };
  }

  const leftover: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  const langchain = isLangChainRun(leftover, read);
  const produced: Record<string, AttributeValue> = {};
  for (const [member, target, convert] of INVOCATION_PARAMETER_MEMBERS) {
    if (!Object.hasOwn(leftover, member)) continue;
    if (produced[target] !== undefined) {
      // A second spelling with the same value (LangChain's model_name next to
      // model) is a duplicate, and goes like a promoted member. Left in the
      // bag, it would be promoted on the next pass, so normalizing twice would
      // differ from normalizing once.
      if (sameValue(convert(leftover[member]), produced[target])) delete leftover[member];
      continue;
    }
    if (langchain && target === GEN_AI_REQUEST_STREAM) continue;
    const value = convert(leftover[member]);
    // Wrong shape for the canonical key; leave it where it was.
    if (value === undefined) continue;
    produced[target] = value;
    delete leftover[member];
  }
  const provider = langchain ? langchainProvider(read) : undefined;
  if (Object.keys(produced).length === 0) {
    const unchanged: Expansion = { [LLM_INVOCATION_PARAMETERS]: raw };
    if (provider !== undefined) unchanged[GEN_AI_PROVIDER_NAME] = provider;
    return unchanged;
  }
  const expansion: Expansion = { ...produced };
  if (Object.keys(leftover).length > 0) {
    expansion[LLM_INVOCATION_PARAMETERS] = toAttributeValue(leftover);
  }
  if (provider !== undefined) expansion[GEN_AI_PROVIDER_NAME] = provider;
  return expansion;
}

/** `openinference.span.kind` kept, plus the operation it implies. */
export function taxonomyFromKind(raw: AttributeValue | undefined): Expansion {
  if (typeof raw !== "string") return {};
  const operation = operationForKind(raw);
  const produced: Expansion = { [OPENINFERENCE_SPAN_KIND]: raw };
  if (operation !== undefined) produced[GEN_AI_OPERATION_NAME] = operation;
  return produced;
}

/** `gen_ai.operation.name` kept, plus the taxonomy value it implies. */
export function taxonomyFromOperation(raw: AttributeValue | undefined): Expansion {
  if (typeof raw !== "string") return {};
  const kind = kindForOperation(raw);
  const produced: Expansion = { [GEN_AI_OPERATION_NAME]: raw };
  if (kind !== undefined) produced[OPENINFERENCE_SPAN_KIND] = kind;
  return produced;
}

/**
 * Both taxonomy keys on every span, whichever one the instrumentation speaks.
 *
 * These are expanding rules rather than plain ones for a reason that is
 * load-bearing here: a plain rule DELETES its source, and this SDK sets
 * `openinference.span.kind` on every span it emits, so a plain rule would
 * strip that key from all of them. The two keys carry different information
 * and the contract requires both, so neither may be consumed to produce the
 * other. An expander returning its own source key is the shape that says
 * "rewrite, do not consume".
 *
 * Both directions are needed: OpenInference instrumentations set only the
 * kind, a GenAI-native one sets only the operation. A span carrying both is
 * left alone by native-wins — an instrumentation that says LLM +
 * text_completion is telling us something the maps cannot, and re-deriving
 * would flatten it to chat.
 *
 * Identity, so a pending snapshot built at span start is classifiable.
 */
export const TAXONOMY_RULES: readonly NormalizationRule[] = [
  { source: OPENINFERENCE_SPAN_KIND, expand: taxonomyFromKind, identity: true },
  { source: GEN_AI_OPERATION_NAME, expand: taxonomyFromOperation, identity: true },
];

/**
 * The GenAI conventions' METRIC name for time to first chunk. @ai-sdk/otel and
 * pydantic-ai write it onto the chat span as an attribute, in seconds, with no
 * first-token event. Spelled here rather than in semconv.ts for the reason
 * gen_ai.system is: a source spelling we map and never emit.
 */
export const GEN_AI_CLIENT_TIME_TO_FIRST_CHUNK = "gen_ai.client.operation.time_to_first_chunk";

/**
 * The OpenInference model-call and usage families.
 *
 * ORDER MATTERS where two sources share a target: the first rule to produce
 * one keeps it. Provider, then the request model, then the response model,
 * then the tool name, then the finish reason, then the five OpenInference
 * usage rules and the two GenAI-shaped usage spellings after them, then the
 * request bag LAST so the dedicated model rules beat its `model` member.
 *
 * DELIBERATE OMISSIONS — mappings that are not TOTAL, left unmapped so the
 * source rides through under its own name:
 *
 * - `llm.model_name`. Its meaning varies by instrumentation and, in langchain,
 *   within one: the openai one sets it from the RESPONSE object, langchain
 *   prefers the response's llm_output and falls back to request metadata, the
 *   anthropic one writes the request model then overwrites it with the
 *   response model. Neither gen_ai.request.model nor gen_ai.response.model
 *   can hold all of that, and guessing would put a response model on a
 *   request key for a call that never got a response. The request model is
 *   recovered from the request bag's `model` member instead, which is
 *   unambiguous.
 * - `llm.system` as a consumed source. OpenInference emits both, and for
 *   Azure OpenAI they differ (llm.provider = azure, llm.system = openai), so
 *   it is only a fallback for the provider and stays on the span (see
 *   providerFromSystem).
 * - `llm.token_count.total`. No canonical key: the conventions record input
 *   and output and leave the sum to the reader.
 * - `llm.token_count.prompt_details.cache_input` ("input tokens in the prompt
 *   that were cached"). It overlaps cache_read and cache_write without saying
 *   how, so neither canonical cache key can hold it.
 * - `llm.cost.*`. Cost deliberately stays off the wire; the backend prices
 *   from the token counts.
 * - A SUM rule for the input tokens. Every bundled instrumentation already
 *   reports llm.token_count.prompt INCLUSIVE of the cache counts, so summing
 *   again would double-count every cached token. Pinned by a test. For the
 *   Anthropic one that holds only from 0.2.7, the peer floor: earlier versions
 *   copied Anthropic's cache-exclusive input_tokens and dropped both cache
 *   counts, which no rule here could recover.
 */
/**
 * The audio subsets of the usage counts. The rius-semconv registry defines
 * them (upstream keys, `status: planned`), but its generated module leaves
 * planned keys out until a release marks them emitted, so they are spelled
 * here until the vendored module carries them. A subset of
 * gen_ai.usage.input_tokens / output_tokens: never summed into them, never
 * subtracted from them.
 */
const GEN_AI_USAGE_AUDIO_INPUT_TOKENS = `${GEN_AI_USAGE_PREFIX}audio.input_tokens`;
const GEN_AI_USAGE_AUDIO_OUTPUT_TOKENS = `${GEN_AI_USAGE_PREFIX}audio.output_tokens`;

export const OPENINFERENCE_RULES: readonly NormalizationRule[] = [
  // Provider. One rule, two spellings, first present wins: llm.provider is
  // OpenInference's and the more specific (azure/aws/google rather than the
  // product), gen_ai.system is the deprecated GenAI key, which is mapped here
  // and never emitted. That is why gen_ai.system is spelled inline rather
  // than in semconv.ts: that module is the set of keys we EMIT.
  {
    source: ["llm.provider", "gen_ai.system"],
    target: GEN_AI_PROVIDER_NAME,
    convert: providerName,
    identity: true,
  },
  // Last resort, AFTER the rule above so a known host always wins: the API
  // the client speaks. Covers OpenAI clients pointed at a gateway.
  { source: LLM_SYSTEM, expand: providerFromSystem, identity: true },
  // Model. Only the anthropic instrumentation emits this unambiguous pair;
  // see the omission note on llm.model_name.
  {
    source: "llm.request.model_name",
    target: GEN_AI_REQUEST_MODEL,
    convert: copy,
    identity: true,
  },
  { source: "llm.response.model_name", target: GEN_AI_RESPONSE_MODEL, convert: copy },
  // Tool identity. OpenInference writes the bare key only on TOOL spans (on an
  // LLM span the same name sits under llm.tools.N.tool.name instead), so the
  // rule needs no kind guard. Identity, so it also runs at start and a
  // still-running third-party tool call is named on its pending snapshot, as
  // a native one is.
  //
  // Deliberately NO fallback to the span name. The native path stopped
  // deriving the tool name from the span name because a span name is not a
  // tool name, and a wrong name silently groups unrelated calls, which is
  // worse than an absent one. A third-party span offers no better guarantee.
  { source: "tool.name", target: GEN_AI_TOOL_NAME, convert: textValue, identity: true },
  // Why the model stopped. The source is a SCALAR and the canonical key is an
  // array (one entry per generation), so wrap rather than copy.
  //
  // Known limit: the source only ever holds ONE generation's reason. The
  // OpenInference OpenAI instrumentation reads choices[0].finish_reason on a
  // completed response, and whichever choice finished last on a stream. With
  // n > 1 the array therefore has one entry, not n: a request whose choices
  // finish ["stop", "length", "stop"] records ["stop"], and nothing on the span
  // says the list is short. Accepted rather than skipped: n > 1 is rare in
  // agent code, and the first reason is still the most useful single fact.
  //
  // The VALUE is passed through untouched, deliberately. The registry defines
  // this key as a free-form string array with no enum, and says
  // instrumentations report whatever the provider supplied. The JS
  // instrumentations already do: they emit the provider's value verbatim.
  // OpenInference's PYTHON conversion layer is what lowercases and folds
  // tool_calls/function_call into tool_call; following it would replace the
  // string OpenAI actually returned with one neither the provider nor the
  // conventions use, while leaving Anthropic's end_turn and tool_use alone, so
  // it would cost fidelity and unify nothing. Grouping "stop" with "end_turn"
  // is a question for a reader who still has both, not for the SDK that would
  // destroy one of them. The native path (Generation.setFinishReasons) records
  // verbatim too, so both paths agree.
  { source: "llm.finish_reason", target: GEN_AI_RESPONSE_FINISH_REASONS, convert: wrapInList },
  // Usage. toInt rather than copy: a count under a canonical key must be a
  // count, and a converter that yields nothing is how a wrongly-shaped value
  // stays off the wire.
  { source: "llm.token_count.prompt", target: GEN_AI_USAGE_INPUT_TOKENS, convert: toInt },
  { source: "llm.token_count.completion", target: GEN_AI_USAGE_OUTPUT_TOKENS, convert: toInt },
  {
    source: "llm.token_count.prompt_details.cache_read",
    target: GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
    convert: toInt,
  },
  {
    source: "llm.token_count.prompt_details.cache_write",
    target: GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS,
    convert: toInt,
  },
  {
    source: "llm.token_count.completion_details.reasoning",
    target: GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
    convert: toInt,
  },
  // The audio subsets: copied as they are, never added to or subtracted from
  // the input and output counts, which already include them.
  {
    source: "llm.token_count.prompt_details.audio",
    target: GEN_AI_USAGE_AUDIO_INPUT_TOKENS,
    convert: toInt,
  },
  {
    source: "llm.token_count.completion_details.audio",
    target: GEN_AI_USAGE_AUDIO_OUTPUT_TOKENS,
    convert: toInt,
  },
  // Two GenAI-shaped spellings of the same counts, each its own rule AFTER
  // the OpenInference one for its target: the OpenInference count keeps the
  // target where a span somehow carries both, and a separate rule rather than
  // a second source means an OpenInference count that won't parse still lets
  // a usable alternate through (a rule converts only its first present
  // source). Spelled inline for the reason gen_ai.system is: source spellings
  // we map and never emit.
  //
  // cache_creation is the cache-write count's name before the upstream rename
  // to cache_write. Permanent, not a transition aid: current third-party
  // releases still emit it (@ai-sdk/otel for every Vercel AI SDK app, and
  // pydantic-ai), and the backend prices cache writes from the canonical key
  // alone. The rename is exact, so nothing is lost.
  {
    source: "gen_ai.usage.cache_creation.input_tokens",
    target: GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS,
    convert: toInt,
  },
  // @ai-sdk/otel's flattening of a provider's input_token_details (OpenAI's
  // transcription models): the audio subset of the input. Its text_tokens
  // twin has no per-modality key we emit, and stays.
  {
    source: "gen_ai.usage.input_token_details.audio_tokens",
    target: GEN_AI_USAGE_AUDIO_INPUT_TOKENS,
    convert: toInt,
  },
  // pydantic-ai writes each provider's usage details under
  // gen_ai.usage.details.<name>, and three of those names are the same
  // reasoning split: OpenAI's reasoning_tokens, Anthropic's thinking_tokens and
  // Google's thoughts_tokens. One per provider, so a span should carry at most
  // one; if it carries several, this order decides and all of them go, as in
  // the sink. Separate rules so one that won't parse does not block the next.
  // The rest of the namespace has no canonical key. Its audio_tokens stays:
  // pydantic-ai merges a provider's input and output details under one name,
  // so the count does not say which direction it is.
  {
    source: "gen_ai.usage.details.reasoning_tokens",
    target: GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
    convert: toInt,
  },
  {
    source: "gen_ai.usage.details.thinking_tokens",
    target: GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
    convert: toInt,
  },
  {
    source: "gen_ai.usage.details.thoughts_tokens",
    target: GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
    convert: toInt,
  },
  // Time to first chunk under the conventions' metric name, which @ai-sdk/otel
  // and pydantic-ai write as a span attribute. The duration is the whole
  // signal: no first-token event is added.
  { source: GEN_AI_CLIENT_TIME_TO_FIRST_CHUNK, expand: firstChunkFromMetric },
  // The request bag, last: the dedicated model rules above take precedence
  // over its `model` member. Identity, because what it promotes is.
  {
    source: LLM_INVOCATION_PARAMETERS,
    expand: invocationParameters,
    identity: true,
    reads: [METADATA],
  },
  // The embedding model: OpenInference's EMBEDDING spans name it here. A
  // non-empty string only, like the tool name. LAST, as in the Python SDK, so
  // it only fills the key when no LLM spelling above produced one. Identity,
  // as the request model is, so a pending embedding span is classifiable.
  {
    source: "embedding.model_name",
    target: GEN_AI_REQUEST_MODEL,
    convert: textValue,
    identity: true,
  },
];

// --- Vercel AI SDK v5/v6 (ai.*) ---
//
// The AI SDK's own telemetry (`experimental_telemetry`) speaks a dialect of
// its own: an `ai.operationId` on every span, the model and provider under
// `ai.model.*`, the request settings under `ai.settings.*`, the prompt and the
// response as JSON under `ai.prompt*` / `ai.response.*`, usage under
// `ai.usage.*`. Mapped here straight onto the conventions, in the shapes
// @ai-sdk/otel (the v7 integration) writes for the same calls, so a v5/v6 app
// and a v7 one store the same row. The sink maps the same dialect the same
// way, so raw AI SDK traffic that never passed through this SDK stores it too.
//
// Source spellings throughout, read from the `ai` package at 5.0.273 and
// 6.0.304 (the recorded versions) and spelled inline, as for every dialect.

/** The AI SDK's operation id. Kept on the span: it is the dialect's own name for the call. */
const VERCEL_OPERATION_ID = "ai.operationId";

/**
 * What an operation id says: its kind, and whether the span is ONE model call
 * (`call`) rather than the wrapper around a run of them. A wrapper's usage
 * repeats its calls' (from v6 on, and on v5's streams, it is the run's total),
 * so it moves to `rius.aggregated_usage.*` and is never counted twice.
 *
 * Only these ids are mapped. Any other keeps its `ai.*` keys apart from the
 * identity ones. v5 and v6 trace nothing else: their image, speech and
 * transcription calls take no telemetry settings.
 */
interface VercelOperation {
  readonly kind: SpanKind;
  readonly call: boolean;
}

/**
 * The operations mapped. The generate/stream wrappers are agent runs
 * (`invoke_agent`, as @ai-sdk/otel classifies them): each owns a loop of
 * model calls and tool executions. A rerank is RERANKER, whose operation is
 * `rerank`, as @ai-sdk/otel names it. Its documents (`ai.documents`) and
 * ranking (`ai.ranking`, indices and scores) stay under the AI SDK's keys,
 * where @ai-sdk/otel writes them too: the conventions define neither.
 */
export const VERCEL_OPERATIONS: Readonly<Record<string, VercelOperation>> = {
  "ai.generateText": { kind: SpanKind.AGENT, call: false },
  "ai.streamText": { kind: SpanKind.AGENT, call: false },
  "ai.generateObject": { kind: SpanKind.AGENT, call: false },
  "ai.streamObject": { kind: SpanKind.AGENT, call: false },
  "ai.generateText.doGenerate": { kind: SpanKind.LLM, call: true },
  "ai.streamText.doStream": { kind: SpanKind.LLM, call: true },
  "ai.generateObject.doGenerate": { kind: SpanKind.LLM, call: true },
  "ai.streamObject.doStream": { kind: SpanKind.LLM, call: true },
  "ai.embed": { kind: SpanKind.EMBEDDING, call: false },
  "ai.embedMany": { kind: SpanKind.EMBEDDING, call: false },
  "ai.embed.doEmbed": { kind: SpanKind.EMBEDDING, call: true },
  "ai.embedMany.doEmbed": { kind: SpanKind.EMBEDDING, call: true },
  "ai.toolCall": { kind: SpanKind.TOOL, call: false },
  "ai.rerank": { kind: SpanKind.RERANKER, call: false },
  "ai.rerank.doRerank": { kind: SpanKind.RERANKER, call: true },
};

function vercelOperation(raw: AttributeValue | undefined): VercelOperation | undefined {
  return typeof raw === "string" && Object.hasOwn(VERCEL_OPERATIONS, raw)
    ? VERCEL_OPERATIONS[raw]
    : undefined;
}

/**
 * `ai.operationId` kept, plus the taxonomy it implies, and `gen_ai.tool.type`
 * on a tool execution: the AI SDK runs only function tools. An id this table
 * does not map is kept and implies nothing.
 */
export function taxonomyFromVercelOperation(raw: AttributeValue | undefined): Expansion {
  const operation = vercelOperation(raw);
  if (operation === undefined) return { [VERCEL_OPERATION_ID]: raw };
  const produced: Expansion = {
    [VERCEL_OPERATION_ID]: raw,
    [OPENINFERENCE_SPAN_KIND]: operation.kind,
    [GEN_AI_OPERATION_NAME]: operationForKind(operation.kind),
  };
  if (operation.kind === SpanKind.TOOL) produced[GEN_AI_TOOL_TYPE] = "function";
  return produced;
}

/**
 * The AI SDK's provider ids (`openai.chat`, `google.vertex.chat`,
 * `amazon-bedrock`) and the registry provider each starts with, first match
 * wins. The list is @ai-sdk/otel's own (`mapProviderName`), so a v5/v6 span
 * names the provider exactly as the v7 integration does for the same call.
 */
const VERCEL_PROVIDER_PREFIXES: ReadonlyArray<readonly [prefix: string, provider: string]> = [
  ["google.vertex", "gcp.vertex_ai"],
  ["google.generative-ai", "gcp.gemini"],
  ["google-vertex", "gcp.vertex_ai"],
  ["amazon-bedrock", "aws.bedrock"],
  ["azure-openai", "azure.ai.openai"],
  ["anthropic", "anthropic"],
  ["openai", "openai"],
  ["azure", "azure.ai.inference"],
  ["google", "gcp.gemini"],
  ["mistral", "mistral_ai"],
  ["cohere", "cohere"],
  ["bedrock", "aws.bedrock"],
  ["groq", "groq"],
  ["deepseek", "deepseek"],
  ["perplexity", "perplexity"],
  ["xai", "x_ai"],
];

/**
 * The registry provider for an AI SDK provider id: `openai.chat` is `openai`.
 * An id no prefix matches (a custom provider, a gateway) passes through as it
 * arrived, which the registry allows: its values are well-known, not closed.
 */
export const vercelProviderName: Converter = (values) => {
  const value = values[0];
  if (typeof value !== "string" || value === "") return undefined;
  const lower = value.toLowerCase();
  for (const [prefix, provider] of VERCEL_PROVIDER_PREFIXES) {
    if (lower === prefix || lower.startsWith(`${prefix}.`) || lower.startsWith(`${prefix}-`)) {
      return provider;
    }
  }
  return value;
};

/**
 * The identity half of the dialect: what is known when the span starts, so a
 * pending snapshot of a still-running call is classified, attributed to its
 * model and provider, and (for a tool) named. Before the OpenInference rules:
 * the AI SDK also writes the deprecated `gen_ai.system`, spelled as its
 * provider id (`openai.chat`), and `ai.model.provider` must name the provider
 * first so that spelling never reaches `gen_ai.provider.name`.
 *
 * The settings are copied, not converted: the AI SDK validates each one's type
 * before the call, and on a model call it writes the same values under
 * `gen_ai.request.*` itself, which wins as native. `ai.settings.maxRetries` is
 * the SDK's own retry budget, not a request parameter, and stays.
 *
 * Everything else (usage, messages, the response) is known only at the end:
 * see {@link normalizeVercelSpan}.
 */
export const VERCEL_RULES: readonly NormalizationRule[] = [
  { source: VERCEL_OPERATION_ID, expand: taxonomyFromVercelOperation, identity: true },
  {
    source: "ai.model.provider",
    target: GEN_AI_PROVIDER_NAME,
    convert: vercelProviderName,
    identity: true,
  },
  { source: "ai.model.id", target: GEN_AI_REQUEST_MODEL, convert: textValue, identity: true },
  { source: "ai.toolCall.name", target: GEN_AI_TOOL_NAME, convert: textValue, identity: true },
  { source: "ai.toolCall.id", target: GEN_AI_TOOL_CALL_ID, convert: textValue, identity: true },
  {
    source: "ai.settings.maxOutputTokens",
    target: GEN_AI_REQUEST_MAX_TOKENS,
    convert: copy,
    identity: true,
  },
  {
    source: "ai.settings.temperature",
    target: GEN_AI_REQUEST_TEMPERATURE,
    convert: copy,
    identity: true,
  },
  { source: "ai.settings.topP", target: GEN_AI_REQUEST_TOP_P, convert: copy, identity: true },
  { source: "ai.settings.topK", target: GEN_AI_REQUEST_TOP_K, convert: copy, identity: true },
  {
    source: "ai.settings.frequencyPenalty",
    target: GEN_AI_REQUEST_FREQUENCY_PENALTY,
    convert: copy,
    identity: true,
  },
  {
    source: "ai.settings.presencePenalty",
    target: GEN_AI_REQUEST_PRESENCE_PENALTY,
    convert: copy,
    identity: true,
  },
  { source: "ai.settings.seed", target: GEN_AI_REQUEST_SEED, convert: copy, identity: true },
  {
    source: "ai.settings.stopSequences",
    target: GEN_AI_REQUEST_STOP_SEQUENCES,
    convert: copy,
    identity: true,
  },
];

/**
 * Canonical keys the AI SDK path produces that semconv.ts does not name.
 * Inline, like the dialect's sources: semconv.ts lists them only as content.
 */
const GEN_AI_SYSTEM_INSTRUCTIONS = "gen_ai.system_instructions";
const GEN_AI_TOOL_CALL_ARGUMENTS = "gen_ai.tool.call.arguments";
const GEN_AI_TOOL_CALL_RESULT = "gen_ai.tool.call.result";

/**
 * Each usage count and its AI SDK spellings, in precedence order: v6's
 * detailed spelling, then the one v5 also writes on its streams
 * (`cachedInputTokens`, `reasoningTokens`). An embedding call reports its
 * input as `ai.usage.tokens`. Every count is inclusive, as the conventions
 * define it: `inputTokens` already holds the cached tokens (`noCacheTokens` is
 * the remainder). The keys without a canonical counterpart (`totalTokens`,
 * `inputTokenDetails.noCacheTokens`, `outputTokenDetails.textTokens`) stay.
 *
 * v5's `promptTokens` / `completionTokens` (generateText and generateObject)
 * are deliberately NOT read. On a model call the AI SDK writes the same counts
 * under `gen_ai.usage.*` itself; on the generateText wrapper v5 takes them
 * from the LAST step's response, not the run's total, so a multi-step run
 * would carry a short total under a key that promises the whole run. They stay
 * under their own names, which nothing reads as usage.
 */
const VERCEL_USAGE: ReadonlyArray<readonly [suffix: string, sources: readonly string[]]> = [
  [
    GEN_AI_USAGE_INPUT_TOKENS.slice(GEN_AI_USAGE_PREFIX.length),
    ["ai.usage.inputTokens", "ai.usage.tokens"],
  ],
  [GEN_AI_USAGE_OUTPUT_TOKENS.slice(GEN_AI_USAGE_PREFIX.length), ["ai.usage.outputTokens"]],
  [
    GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS.slice(GEN_AI_USAGE_PREFIX.length),
    ["ai.usage.inputTokenDetails.cacheReadTokens", "ai.usage.cachedInputTokens"],
  ],
  [
    GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS.slice(GEN_AI_USAGE_PREFIX.length),
    ["ai.usage.inputTokenDetails.cacheWriteTokens"],
  ],
  [
    GEN_AI_USAGE_REASONING_OUTPUT_TOKENS.slice(GEN_AI_USAGE_PREFIX.length),
    ["ai.usage.outputTokenDetails.reasoningTokens", "ai.usage.reasoningTokens"],
  ],
];

/**
 * The first of `sources` that converts, under `target` unless the span already
 * carries it; then every present source goes, as for a table rule. Nothing
 * converting leaves the sources where they were.
 */
function mapVercel(
  attributes: Record<string, AttributeValue | undefined>,
  target: string,
  sources: readonly string[],
  convert: (value: AttributeValue) => AttributeValue | undefined,
): void {
  const present = sources.filter((key) => attributes[key] !== undefined);
  if (present.length === 0) return;
  if (attributes[target] === undefined) {
    for (const key of present) {
      const value = convert(attributes[key] as AttributeValue);
      if (value === undefined) continue;
      attributes[target] = value;
      break;
    }
  }
  if (attributes[target] === undefined) return;
  for (const key of present) delete attributes[key];
}

/** A JSON attribute parsed, or undefined when it is not a string of JSON. */
function parseJson(raw: AttributeValue | undefined): unknown {
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A file or image as a semconv media part: a `uri` when its data is a web
 * address, else a `blob`, which never keeps the bytes (their size and
 * `not_captured` in their place). The modality comes from the media type, so
 * a PDF or a text/plain file is a document, never an image; with no media
 * type, from the part kind. The AI SDK serializes binary data as base64
 * before it reaches the span, so data is a string here; any other shape is
 * not one we can vouch for, and the part keeps only its type.
 */
function filePart(type: string, data: unknown, mediaType: unknown) {
  const kind = type === "image" ? "image" : "document";
  let value = data;
  // v7's tagged file data, which v6 spans may carry from a v7 caller.
  if (isObject(value) && typeof value.type === "string") {
    const tag = value.type;
    if (tag === "text") {
      const text = typeof value.text === "string" ? value.text : "";
      return blobPart(kind, mediaType, Buffer.byteLength(text), NOT_CAPTURED);
    }
    value = tag === "data" ? value.data : tag === "url" ? value.url : "";
  }
  if (typeof value !== "string") return { type };
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return uriPart(kind, mediaType, value);
  }
  return base64Blob(value, kind, mediaType);
}

/** A tool result's payload, unwrapped from the AI SDK's tagged output. */
function toolResponse(output: unknown): unknown {
  if (!isObject(output)) return output === null ? undefined : output;
  switch (output.type) {
    case "text":
    case "error-text":
    case "json":
    case "error-json":
      return output.value;
    case "execution-denied":
      return { denied: true, reason: output.reason };
    default:
      return output;
  }
}

/**
 * One AI SDK message part as a GenAI message part, as @ai-sdk/otel converts
 * it. A part with no string type is not a part we can read, and makes the
 * whole message set unreadable (the caller then leaves the source alone).
 * Null when the part makes no part: an image or file read from a raw payload
 * (`ai.prompt`, the caller's arguments, where a Buffer is a byte array), since
 * media parts come only from message keys; the model call's
 * `ai.prompt.messages` carries the same file as a part.
 */
function vercelPart(part: unknown, raw: boolean): Record<string, unknown> | null | undefined {
  if (!isObject(part) || typeof part.type !== "string") return undefined;
  if (raw && (part.type === "image" || part.type === "file")) return null;
  switch (part.type) {
    case "text":
      return { type: "text", content: part.text };
    case "reasoning":
      return { type: "reasoning", content: part.text };
    case "tool-call":
      return {
        type: "tool_call",
        id: part.toolCallId ?? null,
        name: part.toolName,
        arguments: part.input,
      };
    case "tool-result":
      return {
        type: "tool_call_response",
        id: part.toolCallId ?? null,
        response: toolResponse(part.output),
      };
    case "image":
      return filePart(part.type, part.image, part.mediaType);
    case "file":
      return filePart(part.type, part.data, part.mediaType);
    default:
      return { type: part.type };
  }
}

/** One AI SDK message (a model message or a prompt message) as a GenAI message. */
function vercelMessage(message: unknown, raw: boolean): Record<string, unknown> | undefined {
  if (!isObject(message) || typeof message.role !== "string") return undefined;
  const { content } = message;
  if (typeof content === "string") {
    return { role: message.role, parts: [{ type: "text", content }] };
  }
  if (!Array.isArray(content)) return undefined;
  const parts: Record<string, unknown>[] = [];
  for (const item of content) {
    const part = vercelPart(item, raw);
    if (part === undefined) return undefined;
    if (part !== null) parts.push(part);
  }
  return { role: message.role, parts };
}

/**
 * System instructions as text parts: a string, one system message, or a list
 * of them (`{role: "system", content}`), the shapes `system` takes.
 */
function systemParts(system: unknown): Record<string, unknown>[] | undefined {
  if (typeof system === "string") return [{ type: "text", content: system }];
  if (isObject(system)) return [{ type: "text", content: system.content }];
  if (Array.isArray(system) && system.every(isObject)) {
    return system.map((message) => ({ type: "text", content: message.content }));
  }
  return undefined;
}

/**
 * A message list read into the input messages and the system instructions:
 * system messages become instructions, as @ai-sdk/otel separates them.
 * Undefined when any message cannot be read.
 */
function splitMessages(
  messages: unknown,
  raw: boolean,
): { input: Record<string, unknown>[]; system: Record<string, unknown>[] } | undefined {
  if (!Array.isArray(messages)) return undefined;
  const input: Record<string, unknown>[] = [];
  const system: Record<string, unknown>[] = [];
  for (const item of messages) {
    if (isObject(item) && item.role === "system") {
      system.push({ type: "text", content: item.content });
      continue;
    }
    const message = vercelMessage(item, raw);
    if (message === undefined) return undefined;
    input.push(message);
  }
  return { input, system };
}

/**
 * The prompt a span carries, read into input messages and system
 * instructions. A model call carries the provider-bound messages
 * (`ai.prompt.messages`); a wrapper carries the caller's arguments
 * (`ai.prompt`: `system`, then a `prompt` string or message list, and
 * `messages`). Undefined when there is no prompt or it cannot be read.
 */
function vercelPrompt(
  attributes: Readonly<Record<string, AttributeValue | undefined>>,
):
  | { source: string; input: Record<string, unknown>[]; system: Record<string, unknown>[] }
  | undefined {
  if (attributes["ai.prompt.messages"] !== undefined) {
    const split = splitMessages(parseJson(attributes["ai.prompt.messages"]), false);
    return split && { source: "ai.prompt.messages", ...split };
  }
  if (attributes["ai.prompt"] === undefined) return undefined;
  const prompt = parseJson(attributes["ai.prompt"]);
  if (!isObject(prompt)) return undefined;
  const input: Record<string, unknown>[] = [];
  const system: Record<string, unknown>[] = [];
  if (prompt.system !== undefined && prompt.system !== null) {
    const parts = systemParts(prompt.system);
    if (parts === undefined) return undefined;
    system.push(...parts);
  }
  for (const list of [prompt.prompt, prompt.messages]) {
    if (list === undefined || list === null) continue;
    if (typeof list === "string") {
      input.push({ role: "user", parts: [{ type: "text", content: list }] });
      continue;
    }
    const split = splitMessages(list, true);
    if (split === undefined) return undefined;
    input.push(...split.input);
    system.push(...split.system);
  }
  return { source: "ai.prompt", input, system };
}

/** The AI SDK's finish reasons under the GenAI message schema's names. */
const VERCEL_FINISH_REASONS: Readonly<Record<string, string>> = {
  stop: "stop",
  length: "length",
  "content-filter": "content_filter",
  "tool-calls": "tool_call",
  error: "error",
  other: "stop",
  unknown: "stop",
};

/** The response keys the output message is read from. */
const VERCEL_RESPONSE_CONTENT = [
  "ai.response.reasoning",
  "ai.response.text",
  "ai.response.object",
  "ai.response.toolCalls",
] as const;

/**
 * The response as one assistant output message: reasoning, text (or the
 * generated object, as text), then the tool calls, with the finish reason in
 * the message schema's spelling. Undefined when the span has no response, or
 * its tool calls cannot be read. A tool call's input is JSON the model wrote;
 * it is parsed when it parses, as @ai-sdk/otel records it.
 */
function vercelOutput(
  attributes: Readonly<Record<string, AttributeValue | undefined>>,
): Record<string, unknown> | undefined {
  const finish = attributes["ai.response.finishReason"];
  if (finish === undefined && VERCEL_RESPONSE_CONTENT.every((k) => attributes[k] === undefined)) {
    return undefined;
  }
  const parts: Record<string, unknown>[] = [];
  const reasoning = attributes["ai.response.reasoning"];
  if (typeof reasoning === "string" && reasoning !== "") {
    parts.push({ type: "reasoning", content: reasoning });
  }
  const text = attributes["ai.response.text"] ?? attributes["ai.response.object"];
  if (typeof text === "string" && text !== "") parts.push({ type: "text", content: text });
  if (attributes["ai.response.toolCalls"] !== undefined) {
    const calls = parseJson(attributes["ai.response.toolCalls"]);
    if (!Array.isArray(calls) || !calls.every(isObject)) return undefined;
    for (const call of calls) {
      const input =
        typeof call.input === "string" ? (parseJson(call.input) ?? call.input) : call.input;
      parts.push({ type: "tool_call", id: call.toolCallId, name: call.toolName, arguments: input });
    }
  }
  const message: Record<string, unknown> = { role: "assistant", parts };
  if (typeof finish === "string") {
    message.finish_reason = Object.hasOwn(VERCEL_FINISH_REASONS, finish)
      ? VERCEL_FINISH_REASONS[finish]
      : finish;
  }
  return message;
}

/**
 * `ai.prompt.toolChoice` as `rius.request.tool_choice`: the AI SDK's
 * `{"type": "auto"}` (or none, required) as the mode string, a forced tool's
 * object as compact JSON.
 */
function vercelToolChoice(raw: AttributeValue): AttributeValue | undefined {
  const choice = parseJson(raw);
  if (!isObject(choice)) return undefined;
  const mode = choice.type;
  if (mode === "auto" || mode === "none" || mode === "required") return mode;
  return compactJson(choice);
}

/**
 * @ai-sdk/otel's usage details, its reasoning count among them, and its run and
 * step operations. Source spellings, inline.
 */
const VERCEL_OTEL_REASONING_TOKENS = "ai.usage.outputTokenDetails.reasoningTokens";
const VERCEL_OTEL_USAGE_DETAILS = [
  "ai.usage.inputTokenDetails.noCacheTokens",
  "ai.usage.outputTokenDetails.textTokens",
  VERCEL_OTEL_REASONING_TOKENS,
] as const;
const VERCEL_OTEL_RUN = "invoke_agent";
const VERCEL_OTEL_AGENT_STEP = "agent_step";

/**
 * The usage on @ai-sdk/otel's spans (v7). Its GenAI-native spans carry no
 * `ai.operationId` and write every count under `gen_ai.usage.*` except the
 * reasoning split, which the conventions name but the integration writes only
 * under the AI SDK's spelling, and only with its `usage` option (which the SDK
 * passes; see registerVercelTelemetry).
 *
 * The run span (invoke_agent) reports the whole run's total, which its model
 * calls' chat spans report again, so the total moves to
 * `rius.aggregated_usage.*` and is counted once. With the `usage` option the
 * run is recognisable from the span alone: an invoke_agent span with no
 * `ai.operationId` carrying the usage details only the AI SDK writes. That
 * span-local rule is what the sink applies to raw @ai-sdk/otel traffic, so
 * both paths store the same row; moveAggregatedUsage still covers this SDK's
 * own runs by their tracer. An invoke_agent span without the details (another
 * producer, or @ai-sdk/otel without the option) keeps its usage: it may be the
 * only record of it. An aggregate already on the span wins over the copy, and
 * the copy goes.
 *
 * A step's reasoning count repeats its model call's, so it goes under
 * `rius.aggregated_usage.*` too; a model call's goes under `gen_ai.usage.*`.
 * The other detail keys have no canonical counterpart and stay.
 *
 * Only on a span with no `ai.operationId` that names a GenAI operation. The
 * v6 LegacyOpenTelemetry integration writes the same detail keys, but its
 * spans carry `ai.operationId`, so normalizeVercelSpan never sends them here.
 */
function vercelOtelUsage(attributes: Record<string, AttributeValue | undefined>): void {
  const operation = attributes[GEN_AI_OPERATION_NAME];
  if (typeof operation !== "string") return;
  const run =
    operation === VERCEL_OTEL_RUN &&
    VERCEL_OTEL_USAGE_DETAILS.some((key) => attributes[key] !== undefined);
  // First, so a native reasoning count moves and then wins over the detail key.
  if (run) {
    for (const key of Object.keys(attributes)) {
      if (!key.startsWith(GEN_AI_USAGE_PREFIX)) continue;
      const value = attributes[key];
      delete attributes[key];
      const target = RIUS_AGGREGATED_USAGE_PREFIX + key.slice(GEN_AI_USAGE_PREFIX.length);
      if (value !== undefined && value !== "" && attributes[target] === undefined)
        attributes[target] = value;
    }
  }
  if (attributes[VERCEL_OTEL_REASONING_TOKENS] === undefined) return;
  const prefix =
    run || operation === VERCEL_OTEL_AGENT_STEP
      ? RIUS_AGGREGATED_USAGE_PREFIX
      : GEN_AI_USAGE_PREFIX;
  mapVercel(
    attributes,
    prefix + GEN_AI_USAGE_REASONING_OUTPUT_TOKENS.slice(GEN_AI_USAGE_PREFIX.length),
    [VERCEL_OTEL_REASONING_TOKENS],
    (value) => toInt([value]),
  );
}

/** The end-only half of the dialect; see {@link normalizeVercelSpan}. */
function vercelUsage(
  attributes: Record<string, AttributeValue | undefined>,
  operation: VercelOperation,
): void {
  if (operation.kind === SpanKind.TOOL) return;
  const prefix = operation.call ? GEN_AI_USAGE_PREFIX : RIUS_AGGREGATED_USAGE_PREFIX;
  for (const [suffix, sources] of VERCEL_USAGE) {
    mapVercel(attributes, prefix + suffix, sources, (value) => toInt([value]));
  }
}

/**
 * Map what a Vercel AI SDK span says once it has ended, in place: usage, the
 * prompt and the response as messages, the response's identity, time to first
 * chunk, a tool execution's input and output, and the tool choice. The
 * identity keys were mapped by {@link VERCEL_RULES}; the tool definitions
 * (`ai.prompt.tools`) by {@link normalizeToolDefinitions}.
 *
 * - Usage: a model call's counts under `gen_ai.usage.*`; a wrapper's (the
 *   run's total) under `rius.aggregated_usage.*`, so it is not counted again.
 *   See VERCEL_USAGE for the v5 spelling that is not read.
 * - Messages, in the GenAI message schema as @ai-sdk/otel writes them: system
 *   prompts as `gen_ai.system_instructions`, the rest as
 *   `gen_ai.input.messages`, the response as one assistant message in
 *   `gen_ai.output.messages` carrying its finish reason. A prompt or response
 *   that cannot be read is left where it is, whole.
 * - `ai.response.msToFirstChunk` (`ai.stream.msToFirstChunk` on streamObject)
 *   is milliseconds; `time_to_first_chunk` is seconds, and only a stream has
 *   a first chunk. The `ai.stream.firstChunk` event stays as recorded; it
 *   only fills the duration where the span lacks one (see
 *   {@link firstChunkFromEvent}).
 * - Embedding vectors (`ai.embedding`, `ai.embeddings`) go, as OpenInference's
 *   do (see dropEmbeddingVectors). The inputs (`ai.value`, `ai.values`) stay:
 *   the conventions define no embedding input.
 *
 * Only on a span whose `ai.operationId` is one of {@link VERCEL_OPERATIONS}; a
 * span with none (@ai-sdk/otel's) gets only its usage mapped (see
 * vercelOtelUsage). Every canonical key already present wins, and every
 * mapped source goes.
 */
export function normalizeVercelSpan(attributes: Record<string, AttributeValue | undefined>): void {
  const operation = vercelOperation(attributes[VERCEL_OPERATION_ID]);
  if (operation === undefined) {
    if (attributes[VERCEL_OPERATION_ID] === undefined) vercelOtelUsage(attributes);
    return;
  }
  vercelUsage(attributes, operation);

  const prompt = vercelPrompt(attributes);
  if (prompt !== undefined) {
    if (prompt.system.length > 0 && attributes[GEN_AI_SYSTEM_INSTRUCTIONS] === undefined) {
      attributes[GEN_AI_SYSTEM_INSTRUCTIONS] = toAttributeValue(prompt.system);
    }
    if (prompt.input.length > 0 && attributes[GEN_AI_INPUT_MESSAGES] === undefined) {
      attributes[GEN_AI_INPUT_MESSAGES] = toAttributeValue(prompt.input);
    }
    delete attributes[prompt.source];
  }
  const output = vercelOutput(attributes);
  if (output !== undefined) {
    if (attributes[GEN_AI_OUTPUT_MESSAGES] === undefined) {
      attributes[GEN_AI_OUTPUT_MESSAGES] = toAttributeValue([output]);
    }
    for (const key of VERCEL_RESPONSE_CONTENT) delete attributes[key];
  }

  mapVercel(attributes, GEN_AI_RESPONSE_ID, ["ai.response.id"], (v) => textValue([v]));
  mapVercel(attributes, GEN_AI_RESPONSE_MODEL, ["ai.response.model"], (v) => textValue([v]));
  mapVercel(attributes, GEN_AI_RESPONSE_FINISH_REASONS, ["ai.response.finishReason"], (v) =>
    wrapInList([v]),
  );
  mapVercel(attributes, RIUS_REQUEST_TOOL_CHOICE, ["ai.prompt.toolChoice"], vercelToolChoice);
  mapVercel(attributes, GEN_AI_TOOL_CALL_ARGUMENTS, ["ai.toolCall.args"], (v) => textValue([v]));
  mapVercel(attributes, GEN_AI_TOOL_CALL_RESULT, ["ai.toolCall.result"], (v) => textValue([v]));

  for (const key of VERCEL_MS_TO_FIRST_CHUNK) {
    const firstChunk = asNumber(attributes[key]) as number | undefined;
    if (firstChunk === undefined || firstChunk < 0) continue;
    attributes[GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK] ??= firstChunk / 1000;
    attributes[GEN_AI_REQUEST_STREAM] ??= true;
    for (const source of VERCEL_MS_TO_FIRST_CHUNK) delete attributes[source];
    break;
  }

  for (const key of VERCEL_EMBEDDING_VECTORS) delete attributes[key];
}

/**
 * Time to first chunk, in milliseconds, first readable wins: generateText and
 * streamText write the first, streamObject the second. Source spellings, inline.
 */
const VERCEL_MS_TO_FIRST_CHUNK = [
  "ai.response.msToFirstChunk",
  "ai.stream.msToFirstChunk",
] as const;

/** An embedding call's output vectors: one (`embed`) or one per input. */
const VERCEL_EMBEDDING_VECTORS = ["ai.embedding", "ai.embeddings"] as const;

/**
 * The rules `init()` applies. Live in every process: normalization is always
 * on and has no opt-out, so anything listed here is a production rule the
 * moment it is merged — and a mapping rule DELETES its source key, so a rule
 * that maps the wrong thing destroys the original beyond recovery. That trade
 * is justified only by a mapping that is correct and TOTAL for its source; it
 * is never justified by an example. A half-migrated key is worse than an
 * unmigrated one, because the canonical name tells the sink and the console
 * that the value is conventional and they have no way to find out otherwise.
 * The omissions, with their reasons, are listed at OPENINFERENCE_RULES.
 *
 * Taxonomy first: it is the only family whose rules are pure additions, and
 * putting it ahead of the mapping rules keeps the order easy to read. The
 * Vercel AI SDK's rules next, ahead of the OpenInference ones, so its provider
 * id names the provider before the deprecated gen_ai.system it also writes.
 *
 * The taxonomy and OpenInference rules are kept byte-identical to the Python
 * SDK's table, including rule ORDER, so the same input produces the same
 * canonical output in both. The Vercel rules are this SDK's alone: the AI SDK
 * is JavaScript, and the sink maps the same dialect for traffic that reaches
 * it directly.
 */
export const NORMALIZATION_RULES: readonly NormalizationRule[] = [
  ...TAXONOMY_RULES,
  ...VERCEL_RULES,
  ...OPENINFERENCE_RULES,
];

/** A rule's source keys, always as a list. */
function sourceKeys(rule: NormalizationRule): readonly string[] {
  return typeof rule.source === "string" ? [rule.source] : rule.source;
}

/**
 * The namespace prefixes the table maps FROM, for the fast path: a span with
 * no attribute under any of them cannot match a rule, and most spans — our
 * own, which are canonical already — are exactly that.
 */
function sourcePrefixes(rules: readonly NormalizationRule[]): readonly string[] {
  const prefixes = new Set<string>();
  for (const rule of rules) {
    for (const key of sourceKeys(rule)) {
      const dot = key.indexOf(".");
      prefixes.add(dot === -1 ? key : key.slice(0, dot + 1));
    }
  }
  return [...prefixes];
}

/**
 * Applies `rules` to one attribute bag, in place, and returns the source keys
 * that were mapped and must be deleted.
 *
 * The contract, and the whole of it:
 * - A canonical key already present is NEVER overwritten. A producer that
 *   speaks the conventions natively is more authoritative than a translation
 *   of its own dialect, and an instrumentation that emits both must not have
 *   the two fight over export order.
 * - A mapped source key is deleted, including when the canonical key already
 *   won: the point of normalizing is one name for one fact, and leaving the
 *   dialect behind would put both on the wire.
 * - A converter that yields `undefined` did not map anything, so its sources
 *   survive untouched — dropping them would lose the only copy.
 * - Everything else is left exactly as it was found.
 */
/**
 * Source keys a rule consumed, and the canonical keys that now carry them. The
 * sources may be deleted only once every target is actually on the span.
 */
interface Consumption {
  readonly sources: readonly string[];
  readonly targets: readonly string[];
}

function applyRules(
  attributes: Record<string, AttributeValue | undefined>,
  rules: readonly NormalizationRule[],
): { mapped: Consumption[]; rewritten: string[] } {
  const mapped: Consumption[] = [];
  const rewritten: string[] = [];
  const nativeModel = attributes[GEN_AI_REQUEST_MODEL] !== undefined;
  for (const rule of rules) {
    const keys = sourceKeys(rule);
    const present = keys.filter((key) => attributes[key] !== undefined);
    if (present.length === 0) continue;

    if (isExpanding(rule)) {
      let expansion: Expansion;
      try {
        const read: Record<string, AttributeValue> = {};
        for (const key of rule.reads ?? []) {
          const value = attributes[key];
          if (value !== undefined) read[key] = value;
        }
        expansion = rule.expand(attributes[rule.source], read);
      } catch {
        // Fail safe: one bad expander must not cost the other rules or the
        // span.
        continue;
      }
      for (const [key, value] of Object.entries(expansion)) {
        if (value === undefined) continue;
        const ownSource = key === rule.source;
        // Native wins everywhere EXCEPT the rule's own source, which it is
        // rewriting rather than competing for.
        if (!ownSource && attributes[key] !== undefined) continue;
        attributes[key] = value;
        if (ownSource) rewritten.push(key);
      }
      // The source is deleted only when the expansion did not keep it.
      if (expansion[rule.source] === undefined) {
        const targets = Object.keys(expansion).filter((key) => expansion[key] !== undefined);
        mapped.push({ sources: [rule.source], targets });
      }
      continue;
    }

    if (attributes[rule.target] !== undefined) {
      // Native wins; the dialect still goes.
      mapped.push({ sources: present, targets: [rule.target] });
      continue;
    }
    const value = rule.convert(present.map((key) => attributes[key] as AttributeValue));
    if (value === undefined) continue;
    attributes[rule.target] = value;
    mapped.push({ sources: present, targets: [rule.target] });
  }
  // Only a model the rules produced: a native one is the producer's own
  // choice of name. Here, not only at end, because onStart writes the result
  // onto the live span, and by onEnd the model already counts as native.
  const model = attributes[GEN_AI_REQUEST_MODEL];
  if (!nativeModel && typeof model === "string") {
    attributes[GEN_AI_REQUEST_MODEL] = withoutProviderRoute(
      model,
      attributes[GEN_AI_PROVIDER_NAME],
    );
  }
  return { mapped, rewritten };
}

// --- Two passes the rule table cannot express ---
//
// Not everything a dialect says is an attribute, and not every canonical key
// has a single source attribute. Both of these read the span rather than one
// key, so they run beside the table rather than in it.

/**
 * The name the OpenInference instrumentations give the first streamed chunk.
 *
 * Confirmed in `openinference-instrumentation-openai` 0.1.52 for PYTHON,
 * `openinference/instrumentation/openai/_stream.py::_Stream._process_chunk`:
 * on the first iteration it calls `add_event("First Token Stream Event")`
 * with no attributes and no explicit timestamp, so the SDK stamps the moment
 * the chunk arrived. That is the whole signal — the instrumentations set no
 * streaming attribute and no time-to-first-chunk of their own.
 *
 * NO TYPESCRIPT INSTRUMENTATION EMITS IT TODAY. At the pinned peer versions
 * (`@arizeai/openinference-instrumentation-openai` 4.4.1, `-anthropic` 0.2.7,
 * `-langchain` 4.0.17) the string appears nowhere in the packages, and
 * `addEvent` is called only by openinference-core's span wrapper. The mapping
 * is carried anyway so the two SDKs' tables stay identical, and it costs a
 * span with no events nothing. A guard test pins the gap: if it fails,
 * upstream has ADDED the event and this rule has just gone live — which is
 * good news, not a regression.
 */
export const OPENINFERENCE_FIRST_TOKEN_EVENT = "First Token Stream Event";

/**
 * The Vercel AI SDK's (v5/v6) first-token event, on a doStream span, with the
 * measured `ai.response.msToFirstChunk` as its attribute.
 */
export const VERCEL_FIRST_CHUNK_EVENT = "ai.stream.firstChunk";

/** A dialect's first-token marker: the source of a derived time to first chunk. */
function isDialectFirstTokenEvent(name: string): boolean {
  return name === OPENINFERENCE_FIRST_TOKEN_EVENT || name === VERCEL_FIRST_CHUNK_EVENT;
}

/**
 * The canonical streaming attributes for a span a dialect marked with its
 * first-token event (OpenInference's or the Vercel AI SDK's):
 * `gen_ai.request.stream`, and `gen_ai.response.time_to_first_chunk` as the
 * seconds from the span's start to its first marker.
 *
 * Returns the attributes to add. The marker event itself is left as recorded:
 * no `gen_ai.first_token` event is ever written, since the backend derives the
 * one it stores from the duration. This cannot go through the rule table: the
 * table maps attribute keys and the source here is an event.
 *
 * Native wins, as for attributes: a key the span already carries is left out,
 * and the caller adds the rest only where still unset, so a value the table
 * produced is never overwritten either. The duration is never negative. A
 * marker after the span's end is not clamped: it is when the chunk arrived
 * (LlamaIndex ends its stream_chat span before the first chunk), and the
 * backend keeps a recorded marker's time as it is.
 *
 * `gen_ai.request.stream` is INFERRED from the event's presence, so a stream
 * that errors or yields nothing before the first chunk is not marked as
 * streaming even though the request did stream. The native path has exactly
 * the same limitation — `recordFirstToken` is the only thing that sets the
 * flag there — so this is a known boundary rather than a defect introduced
 * here.
 *
 * Unit: `gen_ai.response.time_to_first_chunk` is SECONDS, as a float, which
 * is what the native path emits and what the conventions specify.
 */
export function firstChunkFromEvent(span: ReadableSpan): Record<string, AttributeValue> {
  const marker = span.events?.find((event) => isDialectFirstTokenEvent(event.name));
  if (marker === undefined) return {};
  const attributes = span.attributes ?? {};
  const added: Record<string, AttributeValue> = {};
  // A first chunk arriving is what proves the request streamed — the same
  // inference recordFirstToken makes.
  if (attributes[GEN_AI_REQUEST_STREAM] === undefined) added[GEN_AI_REQUEST_STREAM] = true;
  if (attributes[GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK] === undefined) {
    const at = marker.time;
    // On [seconds, nanos] pairs, not one nanosecond count: a timestamp near
    // 1.7e18 ns is past a double's exact range and would lose tens of nanos.
    const elapsedNanos = (at[0] - span.startTime[0]) * 1e9 + (at[1] - span.startTime[1]);
    added[GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK] = Math.max(elapsedNanos, 0) / 1e9;
  }
  return added;
}

/**
 * The span attribute the metric spelling stands for (same unit, seconds), plus
 * the stream flag: only a streamed response has a first chunk, the inference
 * recordFirstToken makes.
 */
export function firstChunkFromMetric(raw: AttributeValue | undefined): Expansion {
  const seconds = asNumber(raw);
  if (seconds === undefined || (seconds as number) < 0) return {};
  return { [GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK]: seconds, [GEN_AI_REQUEST_STREAM]: true };
}

/**
 * `error.type` from the span's exception event.
 *
 * A failed auto-instrumented span carries an `exception` event with
 * `exception.type` and an ERROR status, but no `error.type` attribute. The
 * conventions make `error.type` Conditionally Required on a failed GenAI
 * span, so those failures are invisible to any grouping on that key.
 *
 * Deliberately NOT part of the OpenInference table: the shape is common to
 * every auto-instrumented source, not to one dialect.
 *
 * Four cases, all of them pinned by tests:
 * - ERROR status, an exception event, no `error.type` -> set it, spelled
 *   exactly as the event spells it so one span never carries two spellings.
 * - ERROR status, NO exception event -> emit nothing. An error with no
 *   exception is not classifiable, and guessing a value would be worse than
 *   leaving it unset.
 * - An exception event but a non-ERROR status -> leave the span alone. An
 *   exception that was recorded and handled is not a failure.
 * - `error.type` already present -> never overwritten, like every other
 *   canonical key.
 */
export function errorTypeFromExceptionEvent(span: ReadableSpan): Record<string, AttributeValue> {
  if (span.status?.code !== SpanStatusCode.ERROR) return {};
  if (span.attributes?.[ERROR_TYPE] !== undefined) return {};
  for (const event of span.events ?? []) {
    if (event.name !== EXCEPTION_EVENT) continue;
    const type = event.attributes?.[EXCEPTION_TYPE];
    if (typeof type === "string" && type !== "") return { [ERROR_TYPE]: type };
  }
  return {};
}

/** OpenInference's flattened message families and the key each becomes. */
const MESSAGE_FAMILIES: ReadonlyArray<readonly [prefix: string, target: string]> = [
  [LLM_INPUT_MESSAGES_PREFIX, GEN_AI_INPUT_MESSAGES],
  [LLM_OUTPUT_MESSAGES_PREFIX, GEN_AI_OUTPUT_MESSAGES],
];

/**
 * Tool-call fields and the part field each fills. Any other `tool_call.*`
 * field is consumed and dropped, as the sink does.
 */
const TOOL_CALL_FIELDS: ReadonlyArray<readonly [field: string, name: string]> = [
  [LLM_TOOL_CALL_ID, "id"],
  [LLM_TOOL_CALL_FUNCTION_NAME, "name"],
  [LLM_TOOL_CALL_FUNCTION_ARGUMENTS, "arguments"],
];

/**
 * An index as the sink's `strconv.Atoi` reads one: an optional sign and ASCII
 * digits, within int64. The sink is the other producer of these keys, and the
 * two must agree on which keys are messages.
 */
const INDEX = /^[+-]?[0-9]+$/;
const INT64_LIMIT = 2n ** 63n;

/** The index, canonical (so "01" and "1" are one message), or undefined. */
function parseIndex(text: string): bigint | undefined {
  if (!INDEX.test(text)) return undefined;
  const value = BigInt(text.startsWith("+") ? text.slice(1) : text);
  return value >= 0n && value < INT64_LIMIT ? value : undefined;
}

/** A map's entries in ascending index order. */
function byIndex<T>(entries: Map<bigint, T>): T[] {
  return [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, value]) => value);
}

/** Ascending by code point, as Python's `sorted` orders strings. */
function byCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const diff = (x[i].codePointAt(0) ?? 0) - (y[i].codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
  return x.length - y.length;
}

/** `head.<index>.rest` split into its parsed index and `rest`, or undefined. */
function cutIndexed(text: string): [bigint, string] | undefined {
  const dot = text.indexOf(".");
  if (dot < 0) return undefined;
  const index = parseIndex(text.slice(0, dot));
  return index === undefined ? undefined : [index, text.slice(dot + 1)];
}

/** One flattened message's fields, gathered before it is encoded. */
interface FlatMessage {
  role: string;
  content: string | undefined;
  toolCallId: string;
  // Null-prototype records: field names come from another producer's keys,
  // and `__proto__` must be a field like any other.
  toolCalls: Map<bigint, Record<string, string>>;
  contents: Map<bigint, Record<string, string>>;
}

function fieldRecord(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

/**
 * One multimodal contents item as a message part, or undefined for no part.
 *
 * - A text item, and nothing more, is a text part. This is how the Anthropic
 *   instrumentors write every text block, replies and block-list system
 *   prompts alike, never as `message.content`.
 * - A `tool_use` item that repeats a tool call the message already carries
 *   adds no part. The Anthropic instrumentors write each tool_use block twice,
 *   under `message.tool_calls.J` and as a contents item, so the call is
 *   already a `tool_call` part. It must hold nothing but the call's fields,
 *   each equal to one tool call's; otherwise it is not provably a copy.
 * - An image item is a media part (see {@link openInferenceImage}).
 * - Anything else (a reasoning block, a text item carrying an id or a
 *   signature, an item without a type) becomes a text part holding the item
 *   serialized. The item is its fields by name (`message_content.` cut,
 *   `tool_call.` kept), sorted, so no field is lost and every producer orders
 *   it the same way.
 */
function contentPart(
  item: Record<string, string>,
  toolCalls: Map<bigint, Record<string, string>>,
): Record<string, unknown> | undefined {
  const names = Object.keys(item).sort(byCodePoint);
  if (names.length === 2 && item.type === "text" && Object.hasOwn(item, "text")) {
    return { type: "text", content: item.text };
  }
  if (item.type === "tool_use" && repeatsToolCall(item, toolCalls)) return undefined;
  if (item.type === OPENINFERENCE_IMAGE) return openInferenceImage(item);
  const sorted = fieldRecord();
  for (const name of names) sorted[name] = item[name];
  return { type: "text", content: toAttributeValue(sorted) };
}

/** An OpenInference image item's type, and its fields with `message_content.` cut. */
const OPENINFERENCE_IMAGE = "image";
const OPENINFERENCE_IMAGE_URL = "image.image.url";
const OPENINFERENCE_IMAGE_MEDIA_TYPE = "image.media_type";

/**
 * An OpenInference image item as a media part. A data URL is a blob (its
 * bytes not kept), an http(s) URL a uri. `__REDACTED__` (the instrumentor
 * dropped an image over its size limit), a data URL holding no bytes
 * (`data:None;url,None`, the Anthropic instrumentor's url image) and an item
 * with no url at all (the JS Anthropic instrumentor keeps only
 * `image.media_type`) are blobs whose bytes never reached us.
 */
function openInferenceImage(item: Record<string, string>): Record<string, unknown> {
  const url = Object.hasOwn(item, OPENINFERENCE_IMAGE_URL) ? item[OPENINFERENCE_IMAGE_URL] : "";
  const mime = Object.hasOwn(item, OPENINFERENCE_IMAGE_MEDIA_TYPE)
    ? item[OPENINFERENCE_IMAGE_MEDIA_TYPE]
    : undefined;
  if (url === "" || url === OPENINFERENCE_REDACTED) {
    return blobPart("image", mime, undefined, REDACTED_UPSTREAM);
  }
  return urlPart(url, "image", mime);
}

/**
 * The fields a tool_use contents item may carry to count as a copy of a tool
 * call, each with the tool-call field it must equal.
 */
const TOOL_USE_ITEM_FIELDS: ReadonlyMap<string, string> = new Map(
  TOOL_CALL_FIELDS.map(([field]) => [`${LLM_TOOL_CALL_PREFIX}${field}`, field]),
);

function repeatsToolCall(
  item: Record<string, string>,
  toolCalls: Map<bigint, Record<string, string>>,
): boolean {
  const fields = Object.keys(item).filter((name) => name !== "type");
  if (!fields.every((name) => TOOL_USE_ITEM_FIELDS.has(name))) return false;
  return [...toolCalls.values()].some((call) =>
    fields.every((name) => {
      const field = TOOL_USE_ITEM_FIELDS.get(name) as string;
      return (Object.hasOwn(call, field) ? call[field] : "") === item[name];
    }),
  );
}

/**
 * The message in the GenAI role/parts shape, as the sink encodes it: the
 * content first (a `tool_call_response` when the message carries a tool-call
 * id, a text part otherwise), then the multimodal contents, then the tool
 * calls, each family in index order. An empty role, id, name or arguments is
 * omitted rather than written empty; empty content is still a part.
 */
function encodeMessage(message: FlatMessage): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [];
  if (message.content !== undefined) {
    parts.push(
      message.toolCallId
        ? { type: "tool_call_response", id: message.toolCallId, response: message.content }
        : { type: "text", content: message.content },
    );
  }
  for (const item of byIndex(message.contents)) {
    const part = contentPart(item, message.toolCalls);
    if (part !== undefined) parts.push(part);
  }
  for (const call of byIndex(message.toolCalls)) {
    const part: Record<string, unknown> = { type: "tool_call" };
    for (const [field, name] of TOOL_CALL_FIELDS) {
      if (Object.hasOwn(call, field) && call[field]) part[name] = call[field];
    }
    parts.push(part);
  }
  return message.role ? { role: message.role, parts } : { parts };
}

/**
 * One family's messages in index order and the keys they consumed; undefined
 * when it has no message, or holds a value that is not a string. OpenInference
 * writes every message field as one, so anything else is a shape we cannot
 * vouch for, and leaving it is safe: the family is content by prefix already.
 */
function reassembleFamily(
  attributes: Readonly<Record<string, AttributeValue | undefined>>,
  prefix: string,
): { messages: Record<string, unknown>[]; consumed: string[] } | undefined {
  const messages = new Map<bigint, FlatMessage>();
  const consumed: string[] = [];
  for (const key of Object.keys(attributes)) {
    if (!key.startsWith(prefix)) continue;
    const indexed = cutIndexed(key.slice(prefix.length));
    if (indexed === undefined) continue;
    const [index, field] = indexed;
    let call: [bigint, string] | undefined;
    let item: [bigint, string] | undefined;
    if (field.startsWith(LLM_MESSAGE_TOOL_CALLS_PREFIX)) {
      const sub = cutIndexed(field.slice(LLM_MESSAGE_TOOL_CALLS_PREFIX.length));
      if (sub?.[1].startsWith(LLM_TOOL_CALL_PREFIX)) {
        call = [sub[0], sub[1].slice(LLM_TOOL_CALL_PREFIX.length)];
      }
    } else if (field.startsWith(LLM_MESSAGE_CONTENTS_PREFIX)) {
      const sub = cutIndexed(field.slice(LLM_MESSAGE_CONTENTS_PREFIX.length));
      if (sub?.[1].startsWith(LLM_MESSAGE_CONTENT_PREFIX)) {
        item = [sub[0], sub[1].slice(LLM_MESSAGE_CONTENT_PREFIX.length)];
      } else if (sub?.[1].startsWith(LLM_TOOL_CALL_PREFIX)) {
        // A tool_use item's call fields sit beside message_content.type
        // rather than under it; they are the item's too, prefix kept.
        item = [sub[0], sub[1]];
      }
    }
    if (
      call === undefined &&
      item === undefined &&
      field !== LLM_MESSAGE_ROLE &&
      field !== LLM_MESSAGE_CONTENT &&
      field !== LLM_MESSAGE_TOOL_CALL_ID
    ) {
      continue;
    }
    const value = attributes[key];
    if (typeof value !== "string") return undefined;
    let message = messages.get(index);
    if (message === undefined) {
      message = {
        role: "",
        content: undefined,
        toolCallId: "",
        toolCalls: new Map(),
        contents: new Map(),
      };
      messages.set(index, message);
    }
    if (call !== undefined) {
      const fields = message.toolCalls.get(call[0]) ?? fieldRecord();
      fields[call[1]] = value;
      message.toolCalls.set(call[0], fields);
    } else if (item !== undefined) {
      const fields = message.contents.get(item[0]) ?? fieldRecord();
      fields[item[1]] = value;
      message.contents.set(item[0], fields);
    } else if (field === LLM_MESSAGE_ROLE) {
      message.role = value;
    } else if (field === LLM_MESSAGE_TOOL_CALL_ID) {
      message.toolCallId = value;
    } else {
      message.content = value;
    }
    consumed.push(key);
  }
  if (messages.size === 0) return undefined;
  return { messages: byIndex(messages).map(encodeMessage), consumed };
}

/**
 * Rebuilds OpenInference's flattened messages as `gen_ai.*.messages`, in
 * place, and reports whether it changed anything. A port of the Python SDK's
 * `reassemble_openinference_messages`, held to the same shared fixture.
 *
 * OpenInference writes one attribute per message field:
 * `llm.input_messages.<i>.message.{role,content,tool_call_id}`,
 * `...message.tool_calls.<j>.tool_call.{id,function.name,function.arguments}`
 * and the multimodal `...message.contents.<k>.message_content.*`, and the same
 * under `llm.output_messages`. Each family becomes one JSON array under its
 * canonical key, in the role/parts shape the generation helpers write, capped
 * like every other JSON attribute, and every key it consumed is deleted.
 *
 * The output is BYTE-IDENTICAL to the sink's `reassembleMessages` for the same
 * input; the one known difference is that the sink does not cap the attribute.
 * That is why this does not reuse the generation helpers' message
 * normalization, which would default a missing role and write `null` for a
 * missing tool-call field.
 *
 * The multi-part `contents` form is not optional: the Anthropic instrumentors
 * write EVERY text block there, never in `message.content`, so without it an
 * Anthropic reply or a block-list system prompt arrives with empty parts.
 *
 * Native wins: a family whose canonical key is already present is left
 * entirely as it came, flattened keys included, as the sink leaves it. Nothing
 * is written until both families have been read, so the bag is never mutated
 * while it is being iterated.
 */
export function reassembleOpenInferenceMessages(
  attributes: Record<string, AttributeValue | undefined>,
): boolean {
  const keys = Object.keys(attributes);
  if (!keys.some((key) => MESSAGE_FAMILIES.some(([prefix]) => key.startsWith(prefix)))) {
    return false;
  }
  const writes: Array<{ target: string; value: AttributeValue; consumed: string[] }> = [];
  for (const [prefix, target] of MESSAGE_FAMILIES) {
    if (Object.hasOwn(attributes, target) && attributes[target] !== undefined) continue;
    const family = reassembleFamily(attributes, prefix);
    if (family === undefined) continue;
    writes.push({ target, value: toAttributeValue(family.messages), consumed: family.consumed });
  }
  for (const { target, value, consumed } of writes) {
    for (const key of consumed) delete attributes[key];
    attributes[target] = value;
  }
  return writes.length > 0;
}

/**
 * Native semconv media parts in the message keys, in their normalized shape,
 * in place: a blob loses its content (any instrumentor writing blob parts,
 * pydantic-ai and @ai-sdk/otel among them), and each media part takes its
 * modality from its MIME type (@ai-sdk/otel labels a PDF or a text/plain file
 * an image). Only a rebuilt part's own bytes are rewritten, as the sink
 * rewrites them; a key that does not parse, or holds no part to change, is
 * left byte for byte as it came.
 */
export function normalizeNativeMediaParts(
  attributes: Record<string, AttributeValue | undefined>,
): void {
  for (const key of [GEN_AI_INPUT_MESSAGES, GEN_AI_OUTPUT_MESSAGES, GEN_AI_SYSTEM_INSTRUCTIONS]) {
    const value = attributes[key];
    if (typeof value !== "string") continue;
    const rebuilt = rebuildNativeMediaParts(value, key !== GEN_AI_SYSTEM_INSTRUCTIONS);
    if (rebuilt !== value) attributes[key] = rebuilt;
  }
}

/** Every string, and every string of a string array, of a bag stripped in place. */
function stripBag(attributes: Record<string, AttributeValue | undefined> | undefined): void {
  if (attributes === undefined) return;
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string") {
      const stripped = stripRawPayload(value);
      if (stripped !== value) attributes[key] = stripped;
    } else if (Array.isArray(value) && value.some((item) => typeof item === "string")) {
      const stripped = value.map((item) =>
        typeof item === "string" ? stripRawPayload(item) : item,
      );
      if (stripped.some((item, i) => item !== value[i])) {
        attributes[key] = stripped as AttributeValue;
      }
    }
  }
}

/**
 * Inline media stripped from every string of the span, in place: its
 * attributes (raw payloads such as `input.value`, `output.value` and
 * `ai.prompt`, the message keys too) and its events' and links' attributes.
 * Each media token is replaced where it sits and every other byte is kept
 * (see mediaParts.ts). The resource and scope attributes are shared across
 * spans and are not ours to rewrite here.
 */
export function stripSpanPayloads(span: ReadableSpan): void {
  stripBag(span.attributes as Record<string, AttributeValue | undefined>);
  for (const event of span.events ?? []) {
    stripBag(event.attributes as Record<string, AttributeValue | undefined> | undefined);
  }
  for (const link of span.links ?? []) {
    stripBag(link.attributes as Record<string, AttributeValue | undefined> | undefined);
  }
}

/**
 * OpenInference's indexed tool-definition family, `llm.tools.{i}.tool.json_schema`.
 * A source spelling, inline for the reason the `llm.*` rule sources are.
 */
const LLM_TOOL_SCHEMA = /^llm\.tools\.([0-9]+)\.tool\.json_schema$/;

/**
 * Reassemble a span's tool definitions into one `gen_ai.tool.definitions`,
 * in place.
 *
 * Outside the rule table because the source is an INDEXED family and a rule's
 * sources are exact keys. End-only, which is also right on the merits:
 * definitions are content, so they never ride a pending snapshot.
 *
 * Three sources, the first present wins:
 *
 * - `llm.tools.N.tool.json_schema`, which the OpenInference instrumentations
 *   write one per tool. Each value is a JSON string; the schemas are parsed
 *   and re-serialized as ONE array, in numeric index order, VERBATIM: an
 *   Anthropic `input_schema` stays an Anthropic `input_schema`, as on the
 *   native `tools` option. The indexed keys are then deleted. If any one
 *   schema is not a string or does not parse, the whole family is left
 *   untouched rather than reassembled without it: it is content by prefix
 *   already, so nothing escapes, and a partial array would be a silent loss.
 * - Only when there is no indexed schema at all: the tool-definition members
 *   of `llm.invocation_parameters` (`tools`, then the legacy `functions`),
 *   where litellm and langchain leave them. Both present are concatenated,
 *   tools first, and only when every present member is a list. The members
 *   leave the bag, and a bag left empty is dropped rather than riding as `{}`.
 *   When the indexed schemas were the source, the bag's members are
 *   duplicates of them and leave the bag all the same.
 * - Only when neither is there: the Vercel AI SDK's `ai.prompt.tools`, a
 *   string array of JSON-stringified tools, as the sink reads it.
 *
 * Native wins: a span already carrying `gen_ai.tool.definitions` keeps it,
 * and the sources are removed anyway because they are then duplicates.
 *
 * Runs before masking, so the promoted key is stripped under
 * `captureContent: false` exactly like a native one: it is on the content
 * allowlist.
 *
 * Ported from the Python SDK's `normalize_tool_definitions`, rule for rule.
 * Two language differences reach its edges: `JSON.parse` rejects the `NaN` /
 * `Infinity` tokens Python's `json.loads` accepts, so such a schema leaves the
 * family untouched here, and the index pattern is ASCII digits only where
 * Python's `\d` also matches other Unicode digits.
 */
export function normalizeToolDefinitions(
  attributes: Record<string, AttributeValue | undefined>,
): void {
  const native = attributes[GEN_AI_TOOL_DEFINITIONS] !== undefined;

  const indexed = new Map<number, string>();
  for (const key of Object.keys(attributes)) {
    // The cheap prefix test first: this runs on every ended span.
    if (!key.startsWith("llm.tools.")) continue;
    const match = LLM_TOOL_SCHEMA.exec(key);
    if (match !== null) indexed.set(Number(match[1]), key);
  }
  if (indexed.size > 0) {
    const schemas: unknown[] = [];
    for (const index of [...indexed.keys()].sort((a, b) => a - b)) {
      const raw = attributes[indexed.get(index) as string];
      if (typeof raw !== "string") return;
      try {
        schemas.push(JSON.parse(raw));
      } catch {
        return;
      }
    }
    for (const key of indexed.values()) delete attributes[key];
    // litellm and langchain write the same definitions into the request bag
    // as well. They are duplicates of the ones just reassembled, and go now:
    // left behind, a second normalization would find a native
    // gen_ai.tool.definitions and remove them then, so normalizing twice
    // would differ from normalizing once.
    takeBagDefinitions(attributes);
    if (!native) attributes[GEN_AI_TOOL_DEFINITIONS] = toAttributeValue(schemas);
    return;
  }

  const definitions = takeBagDefinitions(attributes);
  if (definitions !== undefined) {
    if (!native) attributes[GEN_AI_TOOL_DEFINITIONS] = toAttributeValue(definitions);
    return;
  }

  // Last, the Vercel AI SDK's ai.prompt.tools: one JSON-stringified tool per
  // element, each kept as the AI SDK wrote it. Every element must parse, or
  // the key stays whole.
  const tools = attributes[VERCEL_PROMPT_TOOLS];
  if (tools === undefined) return;
  const elements = Array.isArray(tools) ? tools : parseJson(tools);
  if (!Array.isArray(elements)) return;
  const parsed: unknown[] = [];
  for (const element of elements) {
    if (typeof element !== "string") {
      parsed.push(element);
      continue;
    }
    try {
      parsed.push(JSON.parse(element));
    } catch {
      return;
    }
  }
  delete attributes[VERCEL_PROMPT_TOOLS];
  if (!native && parsed.length > 0) {
    attributes[GEN_AI_TOOL_DEFINITIONS] = toAttributeValue(parsed);
  }
}

/** The Vercel AI SDK's tool definitions. A source spelling, inline. */
const VERCEL_PROMPT_TOOLS = "ai.prompt.tools";

/**
 * Remove the request bag's tool-definition members and return them, or
 * undefined (bag untouched) when it holds none, or holds them in a shape we
 * cannot vouch is a list of definitions: the bag is content already, so
 * leaving it is safe. A bag left empty goes too, rather than riding as `{}`.
 */
function takeBagDefinitions(
  attributes: Record<string, AttributeValue | undefined>,
): unknown[] | undefined {
  const bag = attributes[LLM_INVOCATION_PARAMETERS];
  if (typeof bag !== "string") return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(bag);
  } catch {
    return undefined;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const members = payload as Record<string, unknown>;
  const present = INVOCATION_PARAMETERS_CONTENT_MEMBERS.filter((m) => Object.hasOwn(members, m));
  if (present.length === 0 || !present.every((m) => Array.isArray(members[m]))) return undefined;
  const definitions = present.flatMap((m) => members[m] as unknown[]);
  const leftover = Object.fromEntries(
    Object.entries(members).filter(([key]) => !present.includes(key)),
  );
  if (Object.keys(leftover).length > 0) {
    attributes[LLM_INVOCATION_PARAMETERS] = toAttributeValue(leftover);
  } else {
    delete attributes[LLM_INVOCATION_PARAMETERS];
  }
  return definitions;
}

/**
 * `value` (parsed JSON) as compact JSON with object keys sorted by code point
 * at every depth, strings as {@link jsonString} writes them.
 * That is byte for byte what the sink's shared encoder writes for a decoded
 * `map[string]any`, whose keys Go always sorts, so the two producers agree on
 * a block neither of them can type.
 */
function sortedCompactJson(value: unknown): string {
  if (typeof value === "string") return jsonString(value);
  if (Array.isArray(value)) return `[${value.map(sortedCompactJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort(byCodePoint)
      .map((k) => `${jsonString(k)}:${sortedCompactJson(record[k])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * One element of a block-list system prompt as a message part: a text block's
 * text, and nothing else of it (its `cache_control`, citations and so on are
 * request plumbing, not what the model read), or any other block as its
 * compact JSON, as an unknown contents item is carried in the reassembly.
 */
function systemPart(block: unknown): Record<string, unknown> {
  if (block !== null && typeof block === "object" && !Array.isArray(block)) {
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      return { type: "text", content: record.text };
    }
  }
  return { type: "text", content: sortedCompactJson(block) };
}

/**
 * Promote the request's `system` member out of `llm.invocation_parameters`
 * into a system input message, in place; reports whether it changed anything.
 *
 * The OpenInference Anthropic instrumentation (JS) records the request body
 * minus `messages` as the bag, so Anthropic's top-level `system` prompt stays
 * in it and never becomes a message: context attribution then books nearly
 * the whole prompt as unattributed. The Python instrumentor emits it as a
 * message already, and the sink applies this same rule to foreign JS traffic.
 *
 * - Only when the span has no system-role input message: an instrumentation
 *   that already wrote one wins, like every native key.
 * - A non-empty string becomes `{"role":"system","parts":[{"type":"text",
 *   "content":<string>}]}`; a non-empty list becomes ONE system message with a
 *   part per element (see {@link systemPart}). Any other shape, an empty
 *   string and an empty list included, is not something we can vouch is a
 *   prompt, so the bag is left as it came.
 * - Prepended to `gen_ai.input.messages`, created when absent. Messages that
 *   are present but not a JSON array are a shape we cannot extend, so the
 *   span is left alone.
 * - `system` leaves the bag, and a bag left empty is dropped, as the
 *   `tool_choice` promotion does.
 *
 * End-only and after the reassembly, which produces the messages it extends.
 * Before masking, so under `captureContent: false` the system message is
 * stripped with the rest of the messages.
 */
export function promoteSystemInstruction(
  attributes: Record<string, AttributeValue | undefined>,
): boolean {
  const bag = attributes[LLM_INVOCATION_PARAMETERS];
  if (typeof bag !== "string") return false;
  let payload: unknown;
  try {
    payload = JSON.parse(bag);
  } catch {
    return false;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const members = payload as Record<string, unknown>;
  if (!Object.hasOwn(members, "system")) return false;
  const system = members.system;
  let parts: Record<string, unknown>[];
  if (typeof system === "string" && system !== "") {
    parts = [{ type: "text", content: system }];
  } else if (Array.isArray(system) && system.length > 0) {
    parts = system.map(systemPart);
  } else {
    return false;
  }

  let messages: unknown[] = [];
  const existing = attributes[GEN_AI_INPUT_MESSAGES];
  if (existing !== undefined) {
    if (typeof existing !== "string") return false;
    try {
      const parsed: unknown = JSON.parse(existing);
      if (!Array.isArray(parsed)) return false;
      messages = parsed;
    } catch {
      return false;
    }
  }
  if (messages.some((m) => (m as { role?: unknown } | null)?.role === "system")) return false;

  attributes[GEN_AI_INPUT_MESSAGES] = toAttributeValue([{ role: "system", parts }, ...messages]);
  const leftover = Object.fromEntries(Object.entries(members).filter(([key]) => key !== "system"));
  if (Object.keys(leftover).length > 0) {
    attributes[LLM_INVOCATION_PARAMETERS] = toAttributeValue(leftover);
  } else {
    delete attributes[LLM_INVOCATION_PARAMETERS];
  }
  return true;
}

/**
 * OpenInference's embedding vectors, `embedding.embeddings.N.embedding.vector`.
 * A source spelling, inline for the reason the `llm.*` rule sources are.
 */
const EMBEDDING_VECTOR = /^embedding\.embeddings\.[0-9]+\.embedding\.vector$/;

/**
 * Drop OpenInference's embedding vectors, in place.
 *
 * A vector is the model's OUTPUT as a few thousand floats per input: nothing a
 * trace can show or the backend reads, and by far the largest thing on the
 * span (a 1536-dimension vector per input, as an attribute each). So it goes
 * regardless of the capture setting. The matching `...embedding.text` keys
 * stay: they are the inputs, content by suffix, masked under
 * `captureContent: false` like every other content key. The index is ASCII
 * digits only, with no sign and no bound, as in the Python SDK.
 */
export function dropEmbeddingVectors(attributes: Record<string, AttributeValue | undefined>): void {
  const doomed = Object.keys(attributes).filter(
    (key) => key.startsWith("embedding.") && EMBEDDING_VECTOR.test(key),
  );
  for (const key of doomed) delete attributes[key];
}

/**
 * `gen_ai.response.id` from an LLM span's `output.value`, or nothing.
 *
 * The OpenInference instrumentations record the provider's whole response
 * body as `output.value` and no id attribute, so the id that ties a span to
 * the provider's own logs is only inside that payload. Taken when, and only
 * when:
 *
 * - the span is an LLM span (`openinference.span.kind` is LLM, which the
 *   taxonomy rules also derive from a GenAI operation name);
 * - it has no native `gen_ai.response.id`;
 * - `output.mime_type`, when present, is `application/json`. The JS
 *   instrumentors write a stream's accumulated reply TEXT as `output.value`
 *   (mime `text/plain`), and a JSON-mode reply may well be an object with an
 *   `id` of the model's making, which must not pass for the response's;
 * - `output.value` is a string whose FIRST character is `{`, checked before
 *   parsing so a plain-text output costs no parse, that parses as a JSON
 *   object with a non-empty string top-level `id`.
 *
 * `output.value` itself is never modified. End-only, since the output exists
 * only then, and before masking, so the id (a reference, not content)
 * survives `captureContent: false` while the payload it came from does not.
 */
export function responseIdFromOutput(
  attributes: Readonly<Record<string, AttributeValue | undefined>>,
): Record<string, AttributeValue> {
  if (attributes[OPENINFERENCE_SPAN_KIND] !== SpanKind.LLM) return {};
  if (attributes[GEN_AI_RESPONSE_ID] !== undefined) return {};
  // Declared anything but JSON, the output is the model's own words: the JS
  // instrumentors record a stream's accumulated reply as text/plain, and a
  // JSON-mode reply's "id" is the model's, not the response's. Undeclared is
  // taken, as the contract has it. A source spelling, inline.
  const mime = attributes["output.mime_type"];
  if (mime !== undefined && mime !== "application/json") return {};
  const output = attributes[OUTPUT_VALUE];
  if (typeof output !== "string" || !output.startsWith("{")) return {};
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return {};
  }
  // Text starting with "{" that parses is always an object: no shape check.
  const id = (payload as Record<string, unknown>).id;
  return typeof id === "string" && id !== "" ? { [GEN_AI_RESPONSE_ID]: id } : {};
}

/**
 * Rewrites third-party attribute dialects to the conventions, in place, on
 * every span. Always on: there is no opt-out, because the canonical names are
 * the contract the rest of the pipeline and the backend are written against.
 *
 * IN PLACE, at `onEnd`, rather than in an exporter wrapper. The JS OTel SDK
 * exposes `ReadableSpan.attributes` as a plain mutable object, so a processor
 * can rewrite the span it is handed without copying it. It also makes
 * ORDERING a matter of processor position: registered
 * ahead of the exporting `BatchSpanProcessor`, this runs before the span is
 * queued and therefore before `MaskingSpanExporter`, which is required —
 * masking must only have to recognise canonical content keys, and reversed it
 * would strip a dialect's content key before the mapping could move it.
 *
 * Attributes are never mutated while being iterated: every rule reads through
 * explicit key lookups and the mapped sources are deleted only after the whole
 * table has run, so a delegate iterating the same bag is unaffected.
 *
 * With the default (empty) table both hooks short-circuit on the first line,
 * so the component costs nothing until a real table lands.
 *
 * `onStart` applies the `identity` rules only. A pending snapshot is built at
 * span start from an allowlist of canonical identity keys, so a dialect key
 * that is not canonicalized by then simply never reaches the snapshot. It also
 * routes the span's `recordException` through errorType.ts, the one seam that
 * sees the error OBJECT an instrumentor records; by `onEnd` only the event's
 * type string is left.
 */
export class NormalizingSpanProcessor implements SpanProcessor {
  private readonly rules: readonly NormalizationRule[];
  private readonly identityRules: readonly NormalizationRule[];
  private readonly prefixes: readonly string[];

  constructor(rules: readonly NormalizationRule[] = NORMALIZATION_RULES) {
    this.rules = rules;
    this.identityRules = rules.filter((rule) => rule.identity === true);
    this.prefixes = sourcePrefixes(rules);
  }

  onStart(span: Span, _parentContext: Context): void {
    // setAttribute rather than a direct write: attribute limits and the
    // recording check belong to the span, not to us.
    this.normalize(span.attributes, this.identityRules, (key, value) =>
      span.setAttribute(key, value),
    );
    // Before any instrumentor can record an exception on this span, so its
    // exception.type (and the error.type derived from it at onEnd) names the
    // error's class rather than the generic "Error" provider SDKs inherit.
    qualifyRecordedExceptions(span);
    // Remembered so a provider call ending under it can mark it; see
    // moveWrappedCallUsage.
    noteWrapperStart(span);
  }

  onEnd(span: ReadableSpan): void {
    // Ended spans have no setAttribute; the bag is writable by reference.
    const attributes = span.attributes as Record<string, AttributeValue | undefined>;
    this.normalize(attributes, this.rules, (key, value) => {
      attributes[key] = value;
    });
    // After the table, which mapped the Vercel AI SDK's identity keys; ahead
    // of every pass below, so their setDefault sees what the dialect said.
    normalizeVercelSpan(attributes);
    // After the table, on its output: the table has already taken the request
    // knobs out of the bag, so what this pass re-serializes is the remainder.
    normalizeToolDefinitions(attributes);
    dropEmbeddingVectors(attributes);
    // After the table, and only at end: neither source exists at span start.
    // The event is added mid-stream, and the status is not ERROR until the
    // failure happens. setDefault semantics — a key the table produced read
    // the span's own data and wins over anything inferred here.
    for (const [key, value] of Object.entries({
      ...firstChunkFromEvent(span),
      ...errorTypeFromExceptionEvent(span),
      ...responseIdFromOutput(attributes),
    })) {
      if (attributes[key] === undefined) attributes[key] = value;
    }
    // Export-stage only, like the event passes, and for a reason of its own:
    // messages are content, so they must never be written at span start, where
    // a pending snapshot could carry them. The sources are an indexed family,
    // which the exact-key rule table cannot match.
    reassembleOpenInferenceMessages(attributes);
    // After the reassembly, whose messages it extends; end-only for the same
    // reason, since a system prompt is content.
    promoteSystemInstruction(attributes);
    // After every pass that writes message keys, on what they wrote and on
    // what the instrumentor did.
    normalizeNativeMediaParts(attributes);
    // Last, so the table has already renamed legacy usage spellings, and
    // end-only because a run's usage is only known once it ends.
    moveAggregatedUsage(span, attributes);
    moveWrappedCallUsage(span, attributes);
    // Truly last: over every string the span will carry, including the
    // message keys every pass above produced.
    stripSpanPayloads(span);
  }

  private normalize(
    attributes: Attributes,
    rules: readonly NormalizationRule[],
    write: (key: string, value: AttributeValue) => void,
  ): void {
    if (rules.length === 0) return;
    const bag = attributes as Record<string, AttributeValue | undefined>;
    // Fast path: a span carrying no key under a mapped namespace — every span
    // this SDK produces itself — costs one scan of its keys and nothing else.
    const keys = Object.keys(bag);
    if (!keys.some((key) => this.prefixes.some((prefix) => key.startsWith(prefix)))) return;

    const staged: Record<string, AttributeValue | undefined> = { ...bag };
    const { mapped, rewritten } = applyRules(staged, rules);
    const rewrote = new Set(rewritten);
    for (const key of Object.keys(staged)) {
      if (staged[key] === undefined) continue;
      // A key an expanding rule rewrote is written even though it was already
      // there: that is the rule replacing its own input, not overwriting a
      // native key.
      if (bag[key] === undefined || (rewrote.has(key) && bag[key] !== staged[key])) {
        write(key, staged[key] as AttributeValue);
      }
    }
    // A source goes only when everything it was mapped to LANDED. At onStart
    // the write is the span's setAttribute, which a span already at its
    // attribute count limit refuses without a word; deleting the source then
    // would lose the fact outright (how `llm.provider` vanished from wide
    // OpenInference spans). Kept, it rides to onEnd, where the bag is written
    // directly and the same rule maps it.
    for (const { sources, targets } of mapped) {
      if (targets.every((key) => bag[key] !== undefined)) {
        for (const key of sources) delete bag[key];
      }
    }
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
