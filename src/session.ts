/**
 * Sessions: group traces of one conversation or agent run under a caller id.
 *
 * A trace is a causal unit and stays short; a session is a correlation unit
 * the application assigns, open ended and spanning turns. The caller mints
 * the id (`withSession` for a scope, `init({ sessionId })` for a process-wide
 * default) and `SessionSpanProcessor` stamps it as the OpenInference
 * `session.id` attribute on every span started in scope.
 *
 * Stamping happens in `onStart`, for two reasons:
 *
 * - The sink derives its session column per span, falling back to the trace
 *   id when the attribute is missing, so a session id set only on the root
 *   would scatter child spans into per-trace pseudo-sessions.
 * - Pending snapshots are built at span start from the identity allowlist;
 *   an attribute set later never reaches them.
 *
 * The id rides OTel context, not a module global, so scopes nest, unwind
 * with the callback even on a throw, and follow async continuations the same
 * way the active span does.
 */
import { randomUUID } from "node:crypto";
import { type Context, context as apiContext, createContextKey } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SESSION_ID } from "./semconv.js";

const SESSION_KEY = createContextKey("rius-session-id");

/**
 * Scope every span started inside `fn` to one session id.
 *
 * Pass the application's own id (a conversation id, a job id) to correlate
 * with it; omit it to mint a fresh UUID for the scope. Either way the scope's
 * id is passed to the callback, so it can be logged or handed to the next
 * turn. Nested scopes override outer ones, and an active scope overrides the
 * `init({ sessionId })` default.
 *
 * There is deliberately no process-wide auto-generation: without an id the
 * backend groups each trace as its own session, which stays true in a server
 * handling many users, while an auto-minted global id would merge every user
 * into one. A generated id is only ever scoped to an explicit callback, where
 * "this is one session" is the caller's own claim.
 *
 * ```typescript
 * await withSession(conversationId, async () => {
 *   await handleTurn(message) // every span of the turn carries session.id
 * })
 * ```
 */
export function withSession<T>(fn: (sessionId: string) => T): T;
export function withSession<T>(sessionId: string, fn: (sessionId: string) => T): T;
export function withSession<T>(
  sessionIdOrFn: string | ((sessionId: string) => T),
  maybeFn?: (sessionId: string) => T,
): T {
  const [sessionId, fn] =
    typeof sessionIdOrFn === "function"
      ? [randomUUID(), sessionIdOrFn]
      : [sessionIdOrFn, maybeFn as (sessionId: string) => T];
  return apiContext.with(apiContext.active().setValue(SESSION_KEY, sessionId), () =>
    fn(sessionId),
  );
}

/**
 * Stamps `session.id` on every span at start. The active `withSession` scope
 * wins; otherwise the `init({ sessionId })` / `RIUS_SESSION_ID` default
 * applies; with neither, the attribute is not set and the sink groups the
 * span by its trace id.
 */
export class SessionSpanProcessor implements SpanProcessor {
  constructor(private readonly defaultSessionId?: string) {}

  onStart(span: Span, parentContext: Context): void {
    const value = parentContext.getValue(SESSION_KEY);
    const sessionId = typeof value === "string" ? value : this.defaultSessionId;
    if (sessionId !== undefined) span.setAttribute(SESSION_ID, sessionId);
  }

  onEnd(_span: ReadableSpan): void {}

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
