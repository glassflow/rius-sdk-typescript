/**
 * Users: attribute every span of a request to the end user it served.
 *
 * The caller supplies the id (`withUser` for a scope) and `UserSpanProcessor`
 * stamps it as the `user.id` attribute on every span started in scope. That
 * key is the one OpenInference defines, Langfuse reads natively, and the
 * OpenTelemetry registry lists; the sink also accepts OTel's `enduser.id`
 * from third-party instrumentors, but this SDK emits one name for one fact.
 *
 * Stamping happens in `onStart`, as for sessions: the sink derives its user
 * column per span, and pending snapshots are built at span start from the
 * identity allowlist, so an attribute set later would reach neither.
 *
 * Two deliberate differences from `withSession`:
 *
 * - No process-wide default and no environment variable. A user is a
 *   property of a request, and a global default would attribute every
 *   request a process ever handles to one person.
 * - Nothing is minted when the caller passes nothing. A session without an
 *   id is still a session; a span without a user is simply anonymous, and
 *   the backend treats an empty user id as exactly that.
 *
 * The id rides OTel context, so scopes nest, unwind with the callback even
 * on a throw, and follow async continuations the same way the active span
 * does.
 */
import { type Context, context as apiContext, createContextKey } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { USER_ID } from "./semconv.js";

const USER_KEY = createContextKey("rius-user-id");

/**
 * Scope every span started inside `fn` to one end user.
 *
 * Pass the application's own identifier for the person the request serves.
 * Prefer an opaque id over an email: it is stored on every span and shown
 * in the console. When only sensitive identifiers exist, hash them first
 * (OTel's `user.hash` / `enduser.pseudo.id` guidance). Nested scopes
 * override outer ones. The id is passed to the callback so it can be logged
 * alongside the work.
 *
 * ```typescript
 * await withUser(request.userId, async () => {
 *   await handle(request) // every span of the request carries user.id
 * })
 * ```
 */
export function withUser<T>(userId: string, fn: (userId: string) => T): T {
  return apiContext.with(apiContext.active().setValue(USER_KEY, userId), () => fn(userId));
}

/**
 * Stamps `user.id` on every span started inside a `withUser` scope. Outside
 * any scope the attribute is not set; there is no default to fall back to,
 * by design (see the module comment).
 */
export class UserSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const value = parentContext.getValue(USER_KEY);
    if (typeof value === "string") span.setAttribute(USER_ID, value);
  }

  onEnd(_span: ReadableSpan): void {}

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
