/**
 * The configured agent name, readable from the span helpers.
 *
 * An AGENT span should say which agent it invokes. The caller usually names
 * it, but a process that runs a single agent already told us its name at
 * `init()`, and the conventions make `gen_ai.agent.name` Conditionally
 * Required rather than optional, so the helpers fall back to the configured
 * name instead of leaving the span silent. The value is also on the Resource;
 * a span carrying it too is not redundant, because resource attributes do not
 * survive every collector pipeline and a consumer reading one span in
 * isolation still needs the answer.
 *
 * It lives here rather than in `client` because `spans` imports `client` for
 * the tracer, so the dependency cannot run back the other way. `init()` sets
 * it and `shutdown()` clears it, the same shape `workspace`'s global routing
 * uses.
 */

import { DEFAULT_SERVICE_NAME } from "./config.js";
import { SpanKind } from "./semconv.js";

let configured: string | undefined;

/** Called by `init()` with the resolved agent name, and by `shutdown()` with undefined. */
export function setConfiguredAgentName(name: string | undefined): void {
  configured = name;
}

/** The agent name from `init()`, or undefined when no client is active. */
export function configuredAgentName(): string | undefined {
  return configured;
}

/**
 * Explicit name, else the configured one; never the span or function name.
 *
 * A tool name falls back to the span name because the two were historically
 * the same string. An agent name does not: a function name is not an agent's
 * identity, so the fallback is the name this process was configured with,
 * which is a real answer, and nothing after that.
 *
 * Except when that configured name is the placeholder. Nothing was named, and
 * `DEFAULT_SERVICE_NAME` is what BOTH the service name and the agent name
 * resolve to in that case, so emitting it would claim an identity the caller
 * never gave and would name every such span `invoke_agent unknown_service`.
 * A bare `invoke_agent` is the honest answer, and it is what the conventions
 * prescribe when the name is not available.
 *
 * A caller who literally names their agent "unknown_service" is treated as
 * not having named one. That is the placeholder's meaning everywhere else in
 * the pipeline, and the alternative is threading a "was this defaulted" flag
 * through the client for a case nobody has.
 */
export function resolveAgentName(
  agentName: string | undefined,
  kind: SpanKind,
): string | undefined {
  if (kind !== SpanKind.AGENT) return undefined;
  if (agentName !== undefined) return agentName;
  return configured === DEFAULT_SERVICE_NAME ? undefined : configured;
}
