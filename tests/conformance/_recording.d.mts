// Types for the vendored _recording.mjs (rius-semconv), covering the one export
// the conformance test uses. Hand-written here, not vendored: the module itself
// stays byte-for-byte what rius-semconv ships.
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

export interface ScenarioJson {
  scenario: string;
  resource: { attributes: unknown[] };
  spans: { scope: { name: string; version: string }; span: Record<string, unknown> }[];
}

export function scenarioJson(
  name: string,
  spans: readonly ReadableSpan[],
  options?: { canonicalize?: boolean },
): ScenarioJson;
