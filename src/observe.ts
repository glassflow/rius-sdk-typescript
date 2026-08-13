import type { SpanKind } from "./semconv.js";
import { startAsCurrentSpan } from "./spans.js";

export interface ObserveOptions {
  name?: string;
  kind?: SpanKind;
  captureInput?: boolean;
  captureOutput?: boolean;
}

/**
 * Wrap a function so each call becomes a span. Returns a function with the
 * same signature, so call sites and types are unchanged.
 *
 * A wrapper rather than a decorator on purpose: TypeScript decorators apply
 * only to class members, and most agent code is plain functions.
 */
export function observe<F extends (...args: never[]) => unknown>(
  fn: F,
  options: ObserveOptions = {},
): (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>> {
  // Named alias so every use below refers to the identical deferred type.
  // Without it, TS re-derives `Awaited<ReturnType<F>>` at each site and,
  // because F is an unresolved generic, fails to see the two derivations as
  // the same type (TS2322: "ReturnType<F> is not assignable to
  // Awaited<ReturnType<F>>") even though they are.
  type R = Awaited<ReturnType<F>>;

  const name = options.name ?? (fn.name || "anonymous");
  const captureInput = options.captureInput ?? true;
  const captureOutput = options.captureOutput ?? true;

  const wrapped = (...args: Parameters<F>): Promise<R> =>
    startAsCurrentSpan<R>(
      name,
      { kind: options.kind, input: captureInput ? args : undefined },
      async (observation): Promise<R> => {
        const result = (await fn(...(args as never[]))) as R;
        if (captureOutput && result !== undefined) observation.setOutput(result);
        return result;
      },
    );

  Object.defineProperty(wrapped, "name", { value: name, configurable: true });
  return wrapped;
}
