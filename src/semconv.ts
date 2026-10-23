/**
 * Semantic conventions for the Rius SDK: the instrumentation-scope name, the
 * span-kind taxonomy and the span attribute keys.
 *
 * The constants and tables come from the rius-semconv registry: they are
 * generated there and vendored, at a pinned release, as `semconv.generated.ts`
 * (see scripts/sync-semconv.sh), and re-exported here. A key, its value and
 * the reason for it change in the registry, not here. This module adds the
 * helper functions that use them, because logic is not registry data.
 */
import type { Attributes, SpanKind as OtelSpanKind } from "@opentelemetry/api";
import {
  CHAIN_SPAN_NAME,
  GEN_AI_OPERATION_NAME,
  GEN_AI_REQUEST_PARAMETERS,
  GEN_AI_TOOL_NAME,
  KIND_BY_OPERATION,
  NAME_TARGET_BY_KIND,
  OPENINFERENCE_SPAN_KIND,
  OPERATION_BY_KIND,
  OTEL_KIND_BY_KIND,
  RIUS_REQUEST_PREFIX,
  SpanKind,
} from "./semconv.generated.js";

/**
 * The response status of an HTTP call. An OpenTelemetry convention key the
 * rius registry does not carry, re-exported here so `src/` imports every
 * attribute key from this module.
 */
export { ATTR_HTTP_RESPONSE_STATUS_CODE as HTTP_RESPONSE_STATUS_CODE } from "@opentelemetry/semantic-conventions";
export * from "./semconv.generated.js";

/**
 * The attribute key one caller-supplied request parameter is recorded under.
 *
 * A parameter the GenAI conventions define, under its canonical name or a
 * recognised provider spelling, normalises to its canonical
 * `gen_ai.request.*` key. Everything else keeps its key verbatim under
 * `rius.request.`. An own-property lookup, so `constructor` or `__proto__`
 * is a caller parameter like any other rather than a match found on the
 * prototype chain.
 */
export function requestAttributeKey(parameter: string): string {
  return Object.hasOwn(GEN_AI_REQUEST_PARAMETERS, parameter)
    ? GEN_AI_REQUEST_PARAMETERS[parameter]
    : `${RIUS_REQUEST_PREFIX}${parameter}`;
}

/**
 * The `gen_ai.operation.name` a taxonomy value implies, or `undefined` when
 * it has none.
 *
 * Takes the raw attribute string rather than the enum, because the caller is
 * normalizing a third-party span where the value is whatever the
 * instrumentation wrote — OpenInference's own taxonomy has GUARDRAIL,
 * EVALUATOR and PROMPT, none of which we model. An unrecognised
 * value yields `undefined` rather than throwing: a span carrying a kind we do
 * not know is not a reason to lose the span.
 */
export function operationForKind(kind: string): string | undefined {
  // hasOwn, not a bare lookup: the value comes from another producer's span,
  // and "constructor" would otherwise resolve through the prototype.
  return Object.hasOwn(OPERATION_BY_KIND, kind) ? OPERATION_BY_KIND[kind as SpanKind] : undefined;
}

export function kindForOperation(operation: string): string | undefined {
  return Object.hasOwn(KIND_BY_OPERATION, operation) ? KIND_BY_OPERATION[operation] : undefined;
}

export function otelSpanKind(kind: SpanKind): OtelSpanKind {
  return OTEL_KIND_BY_KIND[kind];
}

/**
 * Identity attributes for a span of `kind`, for setting AT CREATION.
 * Set at creation so future pending-span snapshots can classify the span.
 *
 * `toolName` is the tool name a TOOL span carries as `gen_ai.tool.name`,
 * Required by the GenAI execute-tool convention. It is taken as its own
 * input rather than read off the span name: once span names follow the
 * `{operation} {target}` convention the two are different strings, so one
 * input cannot serve both. Callers that have no separate tool name pass the
 * span name, which is what they meant before.
 */
export function kindAttributes(kind: SpanKind, toolName?: string): Record<string, string> {
  const attributes: Record<string, string> = { [OPENINFERENCE_SPAN_KIND]: kind };
  const operation = OPERATION_BY_KIND[kind];
  if (operation !== undefined) attributes[GEN_AI_OPERATION_NAME] = operation;
  if (kind === SpanKind.TOOL && toolName !== undefined) attributes[GEN_AI_TOOL_NAME] = toolName;
  return attributes;
}

/**
 * The conventions' span name for a span that will carry `attributes`:
 * `{operation} {target}`, e.g. `chat gpt-4o`, `execute_tool get_weather`,
 * falling back to the bare operation when the target is unknown.
 *
 * Composed from the attributes the span is actually being created with, not
 * from the caller's options, so the name can never disagree with the span it
 * names: the operation is whatever `gen_ai.operation.name` ended up being
 * (a generation may override it to `embeddings`), and the target is the
 * resolved value (a tool name defaulted from the span name, an agent name
 * fallen back to the configured one). It only READS them, so the rendered
 * name never contaminates the attribute it was built from.
 */
export function composeSpanName(kind: SpanKind, attributes: Attributes): string {
  const operation = attributes[GEN_AI_OPERATION_NAME];
  if (typeof operation !== "string") return CHAIN_SPAN_NAME;
  const targetKey = NAME_TARGET_BY_KIND[kind];
  const target = targetKey === undefined ? undefined : attributes[targetKey];
  return typeof target === "string" && target !== "" ? `${operation} ${target}` : operation;
}
