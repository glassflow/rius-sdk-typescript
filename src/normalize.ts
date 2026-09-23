import type { AttributeValue, Attributes, Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_USAGE_INPUT_TOKENS,
} from "./semconv.js";

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
 * the converters. The real tables (OpenInference, Vercel, OpenLLMetry) are
 * separate tickets; the two example rules below exist only to prove the
 * machinery end to end.
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
 * One mapping. `identity` marks a rule whose source is knowable at span START
 * (a model name, a tool name) and which therefore also runs in `onStart`, so
 * pending snapshots — built from an allowlist of CANONICAL identity keys —
 * see the canonical spelling rather than the dialect.
 */
export interface NormalizationRule {
  /** Source key, or several for a converter that combines them (see `sum`). */
  readonly source: string | readonly string[];
  readonly target: string;
  readonly convert: Converter;
  readonly identity?: boolean;
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

/**
 * EXAMPLES ONLY, deliberately two-and-a-bit rules: this ticket ships the
 * mechanism, and the real per-instrumentor tables (OpenInference, Vercel,
 * OpenLLMetry) are their own tickets. These three were chosen because each
 * pins one contract the tables depend on:
 *
 * - `llm.model_name` is an `identity` rule, so it proves the start-time hook
 *   reaches a pending snapshot.
 * - `llm.token_count.prompt` proves a converter that rewrites the value.
 * - `ai.prompt` is a CONTENT source, so it proves normalization runs before
 *   masking: reversed, masking would strip it and the canonical key would
 *   arrive empty. The Vercel ticket decides whether the promoted messages
 *   also need their shape translated; this rule only moves them.
 *
 * Keep this list structurally identical to the Python SDK's: same rule order,
 * same source and target spellings, same converter names.
 */
export const NORMALIZATION_RULES: readonly NormalizationRule[] = [
  { source: "llm.model_name", target: GEN_AI_REQUEST_MODEL, convert: copy, identity: true },
  { source: "llm.token_count.prompt", target: GEN_AI_USAGE_INPUT_TOKENS, convert: toInt },
  { source: "ai.prompt", target: GEN_AI_INPUT_MESSAGES, convert: jsonMember("messages") },
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
): string[] {
  const mapped: string[] = [];
  for (const rule of rules) {
    const keys = sourceKeys(rule);
    const present = keys.filter((key) => attributes[key] !== undefined);
    if (present.length === 0) continue;

    if (attributes[rule.target] !== undefined) {
      mapped.push(...present); // native wins; the dialect still goes
      continue;
    }
    const value = rule.convert(present.map((key) => attributes[key] as AttributeValue));
    if (value === undefined) continue;
    attributes[rule.target] = value;
    mapped.push(...present);
  }
  return mapped;
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
    const mapped = applyRules(staged, rules);
    for (const key of Object.keys(staged)) {
      if (bag[key] === undefined && staged[key] !== undefined) {
        write(key, staged[key] as AttributeValue);
      }
    }
    for (const key of mapped) delete bag[key];
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
