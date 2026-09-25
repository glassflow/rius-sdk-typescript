/**
 * `error.type` and `exception.type` for a thrown value, and the seam that
 * makes a third-party instrumentor's exception event use the same spelling.
 *
 * Why this exists: the Anthropic and OpenAI JS SDKs' error classes never set
 * their own `name`, so `err.name` is the inherited `"Error"` for every
 * provider failure (auth, rate limit, not found, overloaded). OTel JS fills
 * `exception.type` from `err.name`, so every one of them collapsed into a
 * single "Error" group. The class is the fact that tells them apart.
 */
import type { Exception, Span, TimeInput } from "@opentelemetry/api";

/**
 * The package prefix for errors whose prototype chain contains one of these
 * base classes, so the spelling matches Python's `anthropic.NotFoundError`
 * (Python gets it from the class's `__module__`, which those SDKs set to the
 * package name). Keyed by the base class's name, as the installed SDKs spell
 * it; matched by name rather than identity so neither SDK has to be loaded.
 */
const PACKAGE_OF_BASE_CLASS: Readonly<Record<string, string>> = {
  AnthropicError: "anthropic",
  OpenAIError: "openai",
};

/** The name of the class `value` was constructed from, if it has a usable one. */
function className(value: object): string | undefined {
  const ctor: unknown = Object.getPrototypeOf(value)?.constructor;
  return typeof ctor === "function" && ctor.name !== "" ? ctor.name : undefined;
}

/** The package prefix, from the first mapped base class in the chain. */
function packageOf(error: Error): string | undefined {
  for (let proto = Object.getPrototypeOf(error); proto !== null; ) {
    const ctor: unknown = Object.hasOwn(proto, "constructor") ? proto.constructor : undefined;
    if (typeof ctor === "function" && Object.hasOwn(PACKAGE_OF_BASE_CLASS, ctor.name)) {
      return PACKAGE_OF_BASE_CLASS[ctor.name];
    }
    proto = Object.getPrototypeOf(proto);
  }
  return undefined;
}

/**
 * `error.type` for a thrown value. Low-cardinality by construction: a class or
 * name, never the message (which echoes request content).
 *
 * - The error's own `name`, unless that is the generic `"Error"` inherited by
 *   a subclass that never set one; then the class name, which says more.
 * - Prefixed with the provider package when the class descends from a
 *   provider SDK's base error (`anthropic.NotFoundError`), as Python spells it.
 * - A plain `new Error()` is still `"Error"`; a non-Error throwable has no
 *   name, so its runtime type is the only honest label.
 *
 * The same spelling goes into the span's `exception.type` (see
 * {@link exceptionForRecording}), so one span never carries two.
 */
export function errorType(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  try {
    const cls = className(error);
    const bare = error.name === "Error" && cls !== undefined ? cls : error.name;
    const pkg = packageOf(error);
    return pkg === undefined ? bare : `${pkg}.${bare}`;
  } catch {
    // An exotic error (a Proxy, a throwing getter) must never turn the
    // failure path into a second failure.
    return error.name;
  }
}

/**
 * What to hand OTel's `recordException` so `exception.type` is
 * {@link errorType}. Unchanged when OTel would already spell it that way.
 *
 * Otherwise a plain `{ name, message, stack }`: OTel reads exactly those three
 * plus `code`, and `code` WINS over `name` there. OpenAI's API errors carry
 * the body's error code (`model_not_found`) in `code`, so passing it on would
 * record the code instead of the class. It stays on the error object itself
 * and in the provider's response; only the span's type field changes.
 */
export function exceptionForRecording(exception: Exception): Exception {
  if (!(exception instanceof Error)) return exception;
  const type = errorType(exception);
  if (type === exception.name) return exception;
  return { name: type, message: exception.message, stack: exception.stack };
}

/** Marks a `recordException` this module already wrapped. */
const WRAPPED = Symbol("rius.recordException");

/**
 * Route this span's own `recordException` through
 * {@link exceptionForRecording}, so an exception an auto-instrumentor records
 * (OpenInference calls `span.recordException(err)` itself) is typed by its
 * class. The exception-event fallback in normalize.ts then derives the same
 * `error.type` from it.
 *
 * Per span INSTANCE, at `onStart`, and nothing else: no prototype or module is
 * patched, so only spans that pass through Rius's own provider are affected,
 * and the method is otherwise OTel's own. Idempotent, and a span whose method
 * cannot be replaced is left alone.
 */
export function qualifyRecordedExceptions(span: Span): void {
  const original = span.recordException as Span["recordException"] & { [WRAPPED]?: true };
  if (typeof original !== "function" || original[WRAPPED] === true) return;
  const wrapped = Object.assign(
    (exception: Exception, time?: TimeInput): void =>
      original.call(span, exceptionForRecording(exception), time),
    { [WRAPPED]: true as const },
  );
  try {
    span.recordException = wrapped;
  } catch {
    // A frozen or non-writable span: keep OTel's spelling rather than fail.
  }
}
