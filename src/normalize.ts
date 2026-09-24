import {
  type AttributeValue,
  type Attributes,
  type Context,
  SpanStatusCode,
} from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor, TimedEvent } from "@opentelemetry/sdk-trace-base";
import {
  ERROR_TYPE,
  GEN_AI_FIRST_TOKEN_EVENT,
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_CHOICE_COUNT,
  GEN_AI_REQUEST_FREQUENCY_PENALTY,
  GEN_AI_REQUEST_MAX_TOKENS,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_REQUEST_PRESENCE_PENALTY,
  GEN_AI_REQUEST_SEED,
  GEN_AI_REQUEST_STOP_SEQUENCES,
  GEN_AI_REQUEST_STREAM,
  GEN_AI_REQUEST_TEMPERATURE,
  GEN_AI_REQUEST_TOP_K,
  GEN_AI_REQUEST_TOP_P,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  LLM_INVOCATION_PARAMETERS,
  OPENINFERENCE_SPAN_KIND,
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

/**
 * Members of `llm.invocation_parameters` that a `gen_ai.request.*` key
 * represents TOTALLY, in precedence order: the first spelling to produce a
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
];

/**
 * Promote the spec-defined members of the request bag; keep the rest.
 *
 * The leftover members go back under `llm.invocation_parameters`, and that is
 * deliberate rather than a half-measure. The bag's membership is open and
 * provider-defined: the litellm and langchain instrumentations leave the
 * request's `tools` / `functions` arrays in it, which is why masking redacts
 * those members THERE. Fanning unknown members out into keys of our own would
 * move content out from under that redaction and past `captureContent: false`.
 * So a member is promoted only when a canonical key represents it totally,
 * and the bag survives to carry everything else.
 *
 * There is deliberately no `rius.request.<key>` catch-all: that namespace is
 * filled natively and normalization was never meant to populate it.
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
 * then the finish reason, then the five usage rules, then the request bag
 * LAST so the dedicated model rules beat its `model` member.
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
 *   again would double-count every cached token. Pinned by a test.
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
  // Why the model stopped. The source is a SCALAR and the canonical key is an
  // array (one entry per generation), so wrap rather than copy.
  //
  // The VALUE is passed through untouched, deliberately. The registry defines
  // this key as a free-form string array with no enum, and says
  // instrumentations report whatever the provider supplied. OpenInference's
  // own converter lowercases and folds tool_calls/function_call into
  // tool_call; following it would replace the string OpenAI actually returned
  // with one neither the provider nor the conventions use, while leaving
  // Anthropic's end_turn and tool_use alone — so it would cost fidelity and
  // unify nothing. Grouping "stop" with "end_turn" is a question for a reader
  // who still has both, not for the SDK that would destroy one of them. The
  // native path (Generation.setFinishReasons) records verbatim too, so both
  // paths agree.
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
function applyRules(
  attributes: Record<string, AttributeValue | undefined>,
  rules: readonly NormalizationRule[],
): { mapped: string[]; rewritten: string[] } {
  const mapped: string[] = [];
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
      if (expansion[rule.source] === undefined) mapped.push(rule.source);
      continue;
    }

    if (attributes[rule.target] !== undefined) {
      mapped.push(...present); // native wins; the dialect still goes
      continue;
    }
    const value = rule.convert(present.map((key) => attributes[key] as AttributeValue));
    if (value === undefined) continue;
    attributes[rule.target] = value;
    mapped.push(...present);
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
 * (`@arizeai/openinference-instrumentation-openai` 4.2.1, `-anthropic` 0.2.1,
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
    if (event.name !== EXCEPTION_EVENT_NAME) continue;
    const type = event.attributes?.[EXCEPTION_TYPE];
    if (typeof type === "string" && type !== "") return { [ERROR_TYPE]: type };
  }
  return {};
}

/** The OTel exception event and the attribute naming the exception's class. */
const EXCEPTION_EVENT_NAME = "exception";
const EXCEPTION_TYPE = "exception.type";

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
 * that is not canonicalized by then simply never reaches the snapshot.
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
  }

  onEnd(span: ReadableSpan): void {
    // Ended spans have no setAttribute; the bag is writable by reference,
    // which is the same seam the Vercel transform uses.
    const attributes = span.attributes as Record<string, AttributeValue | undefined>;
    this.normalize(attributes, this.rules, (key, value) => {
      attributes[key] = value;
    });
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
    for (const key of mapped) delete bag[key];
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
