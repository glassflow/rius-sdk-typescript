/**
 * Agent identity for the span helpers: the name this process was configured
 * with, and the scope naming whichever agent is running right now.
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

import { context as apiContext, createContextKey } from "@opentelemetry/api";
import { namedAgent } from "./config.js";
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
  return namedConfiguredAgent();
}

/**
 * The configured name, unless it is the placeholder. The suppression itself
 * lives in `config.ts` (see {@link namedAgent}) because the resource's
 * `rius.main_agent.name` is a third reader of the same value and must answer
 * identically; this is just the module-state binding of it.
 */
function namedConfiguredAgent(): string | undefined {
  return namedAgent(configured);
}

/**
 * The enclosing agent scope: who is RUNNING, as opposed to who was invoked.
 *
 * `gen_ai.agent.name` carries two different facts, told apart by
 * `gen_ai.operation.name`. On an `invoke_agent` span it names the agent BEING
 * INVOKED — the span's subject, which the caller passes as `agentName`. On an
 * `execute_tool` span the conventions define it as "the human-readable name
 * of the agent executing the tool", i.e. the agent DOING the call, which is
 * not a property of the tool span at all but of whatever opened it. This key
 * carries that second fact down to the tool spans that need it.
 *
 * It rides OTel context rather than being read back off the parent span, for
 * the reasons `session.ts` gives: scopes nest, unwind with the callback even
 * on a throw, and follow async continuations. Reading the parent span would
 * additionally fail whenever a tool span is not a DIRECT child of the agent
 * span — one CHAIN in between is enough — and the parent's attributes are not
 * reachable through the public API anyway.
 */
const AGENT_SCOPE_KEY = createContextKey("rius-enclosing-agent-name");

/**
 * Run `fn` with `agentName` as the enclosing agent, so TOOL spans opened
 * inside it can say which agent executed them. Nested scopes override outer
 * ones: the innermost agent is the one actually making the call.
 *
 * @internal Not re-exported from the package entry point. The span helpers
 * establish this scope themselves; a caller who wants to name the executing
 * agent opens an AGENT span, which is the thing the name is meant to describe.
 */
export function withAgentScope<T>(agentName: string, fn: () => T): T {
  return apiContext.with(apiContext.active().setValue(AGENT_SCOPE_KEY, agentName), fn);
}

/**
 * The agent a tool call happening right now should be attributed to: the
 * innermost enclosing AGENT scope, else the agent this process was configured
 * with — a single-agent process knows the answer without being told — and
 * nothing at all when that is the placeholder.
 *
 * @internal
 */
export function executingAgentName(): string | undefined {
  const scoped = apiContext.active().getValue(AGENT_SCOPE_KEY);
  return typeof scoped === "string" ? scoped : namedConfiguredAgent();
}
