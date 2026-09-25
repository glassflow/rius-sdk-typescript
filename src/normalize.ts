import {
  type AttributeValue,
  type Attributes,
  type Context,
  SpanStatusCode,
} from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor, TimedEvent } from "@opentelemetry/sdk-trace-base";
import { qualifyRecordedExceptions } from "./errorType.js";
import {
  ERROR_TYPE,
  EXCEPTION_EVENT,
  EXCEPTION_TYPE,
  GEN_AI_FIRST_TOKEN_EVENT,
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
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK,
  GEN_AI_TOOL_DEFINITIONS,
  GEN_AI_TOOL_NAME,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  INVOCATION_PARAMETERS_CONTENT_MEMBERS,
  LLM_INPUT_MESSAGES_PREFIX,
  LLM_INVOCATION_PARAMETERS,
  LLM_MESSAGE_CONTENT,
  LLM_MESSAGE_CONTENTS_PREFIX,
  LLM_MESSAGE_CONTENT_PREFIX,
  LLM_MESSAGE_ROLE,
  LLM_MESSAGE_TOOL_CALLS_PREFIX,
  LLM_MESSAGE_TOOL_CALL_ID,
  LLM_OUTPUT_MESSAGES_PREFIX,
  LLM_TOOL_CALL_FUNCTION_ARGUMENTS,
  LLM_TOOL_CALL_FUNCTION_NAME,
  LLM_TOOL_CALL_ID,
  LLM_TOOL_CALL_PREFIX,
  OPENINFERENCE_SPAN_KIND,
  RIUS_REQUEST_TOOL_CHOICE,
  kindForOperation,
  operationForKind,
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

/** Turns one source value into the whole set of keys that replaces it. */
export type Expander = (raw: AttributeValue | undefined) => Expansion;

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

/** A double, or nothing. Booleans are not numbers here. */
function asNumber(value: unknown): AttributeValue | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** An integer, or nothing. */
function asCount(value: unknown): AttributeValue | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
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

/** One JSON string literal, escaped as the sink's Go encoder escapes it. */
function jsonString(text: string): string {
  return JSON.stringify(text.replace(LONE_SURROGATE, "\ufffd"))
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * `value` (parsed JSON) as compact JSON in raw UTF-8, member order kept.
 *
 * Written out rather than left to `JSON.stringify`, because the result is
 * matched byte for byte: the sink promotes the same member from the same bag
 * and the Python SDK writes the same string. `JSON.stringify` alone would
 * leave U+2028/U+2029 raw and escape an unpaired surrogate, where Go's
 * encoder escapes the first two and replaces the third with U+FFFD, in keys
 * as well as values.
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
  return asText(value);
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
  ["temperature", GEN_AI_REQUEST_TEMPERATURE, asNumber],
  ["top_p", GEN_AI_REQUEST_TOP_P, asNumber],
  ["top_k", GEN_AI_REQUEST_TOP_K, asCount],
  ["max_tokens", GEN_AI_REQUEST_MAX_TOKENS, asCount],
  // OpenAI's replacement for max_tokens on the reasoning models: "an upper
  // bound for the number of tokens that can be generated for a completion",
  // which is what gen_ai.request.max_tokens means. Listed second so a request
  // carrying both keeps the one the provider would honour.
  ["max_completion_tokens", GEN_AI_REQUEST_MAX_TOKENS, asCount],
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
 */
export function invocationParameters(raw: AttributeValue | undefined): Expansion {
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
  const produced: Record<string, AttributeValue> = {};
  for (const [member, target, convert] of INVOCATION_PARAMETER_MEMBERS) {
    if (!Object.hasOwn(leftover, member) || produced[target] !== undefined) continue;
    const value = convert(leftover[member]);
    // Wrong shape for the canonical key; leave it where it was.
    if (value === undefined) continue;
    produced[target] = value;
    delete leftover[member];
  }
  if (Object.keys(produced).length === 0) return { [LLM_INVOCATION_PARAMETERS]: raw }; // unchanged
  const expansion: Expansion = { ...produced };
  if (Object.keys(leftover).length > 0) {
    expansion[LLM_INVOCATION_PARAMETERS] = toAttributeValue(leftover);
  }
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
 * - `llm.system`. NOT the provider: OpenInference emits both, and for Azure
 *   OpenAI they differ (llm.provider = azure, llm.system = openai).
 * - `llm.token_count.total`. No canonical key: the conventions record input
 *   and output and leave the sum to the reader.
 * - `llm.token_count.prompt_details.cache_input` ("input tokens in the prompt
 *   that were cached"). It overlaps cache_read and cache_write without saying
 *   how, so neither canonical cache key can hold it.
 * - `llm.token_count.*_details.audio`. No canonical key.
 * - `llm.cost.*`. Cost deliberately stays off the wire; the backend prices
 *   from the token counts.
 * - A SUM rule for the input tokens. Every bundled instrumentation already
 *   reports llm.token_count.prompt INCLUSIVE of the cache counts, so summing
 *   again would double-count every cached token. Pinned by a test. For the
 *   Anthropic one that holds only from 0.2.7, the peer floor: earlier versions
 *   copied Anthropic's cache-exclusive input_tokens and dropped both cache
 *   counts, which no rule here could recover.
 */
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
  // pydantic-ai writes OpenAI's reasoning count as one entry of its usage
  // details namespace. The other providers' names there for the same split
  // (Anthropic's thinking_tokens, Google's thoughts_tokens) are not mapped,
  // matching the sink; the rest of the namespace has no canonical key.
  {
    source: "gen_ai.usage.details.reasoning_tokens",
    target: GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
    convert: toInt,
  },
  // The request bag, last: the dedicated model rules above take precedence
  // over its `model` member. Identity, because what it promotes is.
  { source: LLM_INVOCATION_PARAMETERS, expand: invocationParameters, identity: true },
];

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
 * putting it ahead of the mapping rules keeps the order easy to read.
 *
 * Kept byte-identical to the Python SDK's table, including rule ORDER, so the
 * same input produces the same canonical output in both.
 */
export const NORMALIZATION_RULES: readonly NormalizationRule[] = [
  ...TAXONOMY_RULES,
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
  for (const rule of rules) {
    const keys = sourceKeys(rule);
    const present = keys.filter((key) => attributes[key] !== undefined);
    if (present.length === 0) continue;

    if (isExpanding(rule)) {
      let expansion: Expansion;
      try {
        expansion = rule.expand(attributes[rule.source]);
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
 * (`@arizeai/openinference-instrumentation-openai` 4.2.1, `-anthropic` 0.2.7,
 * `-langchain` 4.0.17) the string appears nowhere in the packages, and
 * `addEvent` is called only by openinference-core's span wrapper. The mapping
 * is carried anyway so the two SDKs' tables stay identical, and it costs a
 * span with no events nothing. A guard test pins the gap: if it fails,
 * upstream has ADDED the event and this rule has just gone live — which is
 * good news, not a regression.
 */
export const OPENINFERENCE_FIRST_TOKEN_EVENT = "First Token Stream Event";

/**
 * Map the OpenInference first-token event onto the canonical shape: the
 * `gen_ai.first_token` event, `gen_ai.request.stream`, and
 * `gen_ai.response.time_to_first_chunk` derived from the span's start.
 *
 * Returns the canonical attributes to add; the events are renamed in place,
 * the same seam masking already uses for events. This cannot go through the
 * rule table: the table maps attribute keys and the source here is an event.
 *
 * Native wins, as for attributes: a span already carrying a
 * `gen_ai.first_token` event keeps it and the source is dropped rather than
 * kept alongside, where it would double-count as a second first-token marker.
 * Canonical attributes already present are never overwritten.
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
export function normalizeFirstTokenEvent(span: ReadableSpan): Record<string, AttributeValue> {
  const events = span.events;
  if (events === undefined || events.length === 0) return {};
  if (!events.some((event) => event.name === OPENINFERENCE_FIRST_TOKEN_EVENT)) return {};

  const attributes = span.attributes ?? {};
  let canonicalSeen = events.some((event) => event.name === GEN_AI_FIRST_TOKEN_EVENT);
  let firstTokenTime: TimedEvent["time"] | undefined;
  const rebuilt: TimedEvent[] = [];
  for (const event of events) {
    if (event.name !== OPENINFERENCE_FIRST_TOKEN_EVENT) {
      rebuilt.push(event);
      continue;
    }
    firstTokenTime ??= event.time;
    // A duplicate marker; the canonical one is authoritative.
    if (canonicalSeen) continue;
    canonicalSeen = true;
    rebuilt.push({ ...event, name: GEN_AI_FIRST_TOKEN_EVENT });
  }
  // Order is preserved: the rename keeps each event where it was.
  (span.events as TimedEvent[]).splice(0, events.length, ...rebuilt);

  const added: Record<string, AttributeValue> = {};
  // A first chunk arriving is what proves the request streamed — the same
  // inference recordFirstToken makes.
  if (attributes[GEN_AI_REQUEST_STREAM] === undefined) added[GEN_AI_REQUEST_STREAM] = true;
  if (attributes[GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK] === undefined && firstTokenTime) {
    const elapsedNanos = hrTimeToNanos(firstTokenTime) - hrTimeToNanos(span.startTime);
    added[GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK] = Math.max(elapsedNanos, 0) / 1e9;
  }
  return added;
}

/** An OTel `HrTime` ([seconds, nanos]) as a single nanosecond count. */
function hrTimeToNanos(time: TimedEvent["time"]): number {
  return time[0] * 1e9 + time[1];
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
 * - Anything else (an image, a reasoning block, a text item carrying an id or
 *   a signature, an item without a type) becomes a text part holding the item
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
  const sorted = fieldRecord();
  for (const name of names) sorted[name] = item[name];
  return { type: "text", content: toAttributeValue(sorted) };
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
 * Two sources, in order:
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
    if (!native) attributes[GEN_AI_TOOL_DEFINITIONS] = toAttributeValue(schemas);
    return;
  }

  const bag = attributes[LLM_INVOCATION_PARAMETERS];
  if (typeof bag !== "string") return;
  let payload: unknown;
  try {
    payload = JSON.parse(bag);
  } catch {
    return;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;
  const members = payload as Record<string, unknown>;
  const present = INVOCATION_PARAMETERS_CONTENT_MEMBERS.filter((m) => Object.hasOwn(members, m));
  // Absent, or a shape we cannot vouch is a list of definitions: the bag is
  // content already, so leaving it is safe.
  if (present.length === 0 || !present.every((m) => Array.isArray(members[m]))) return;
  const definitions = present.flatMap((m) => members[m] as unknown[]);
  const leftover = Object.fromEntries(
    Object.entries(members).filter(([key]) => !present.includes(key)),
  );
  if (Object.keys(leftover).length > 0) {
    attributes[LLM_INVOCATION_PARAMETERS] = toAttributeValue(leftover);
  } else {
    delete attributes[LLM_INVOCATION_PARAMETERS];
  }
  if (!native) attributes[GEN_AI_TOOL_DEFINITIONS] = toAttributeValue(definitions);
}

/**
 * `value` (parsed JSON) as compact JSON with object keys sorted by code point
 * at every depth, strings escaped as {@link compactJson} escapes them. That is
 * byte for byte what the sink's Go encoder writes for a decoded
 * `map[string]any` with HTML escaping off, whose keys Go always sorts, so the
 * two producers agree on a block neither of them can type.
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
 * Rewrites third-party attribute dialects to the conventions, in place, on
 * every span. Always on: there is no opt-out, because the canonical names are
 * the contract the rest of the pipeline and the backend are written against.
 *
 * IN PLACE, at `onEnd`, rather than in an exporter wrapper. The JS OTel SDK
 * exposes `ReadableSpan.attributes` as a plain mutable object and this SDK
 * already mutates it at `onEnd` for the OpenInference Vercel transform
 * (instrumentation.ts), so a processor keeps one mutation model instead of
 * two. It also makes ORDERING a matter of processor position: registered
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
  }

  onEnd(span: ReadableSpan): void {
    // Ended spans have no setAttribute; the bag is writable by reference,
    // which is the same seam the Vercel transform uses.
    const attributes = span.attributes as Record<string, AttributeValue | undefined>;
    this.normalize(attributes, this.rules, (key, value) => {
      attributes[key] = value;
    });
    // After the table, on its output: the table has already taken the request
    // knobs out of the bag, so what this pass re-serializes is the remainder.
    normalizeToolDefinitions(attributes);
    // After the table, and only at end: neither source exists at span start.
    // The event is added mid-stream, and the status is not ERROR until the
    // failure happens. setDefault semantics — a key the table produced read
    // the span's own data and wins over anything inferred here.
    for (const [key, value] of Object.entries({
      ...normalizeFirstTokenEvent(span),
      ...errorTypeFromExceptionEvent(span),
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
