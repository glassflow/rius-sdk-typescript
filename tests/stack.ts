// Calls made where the stack is nearly used up, as when the SDK's onEnd runs
// at the bottom of a caller's deep recursion.

/** The stack running out: a RangeError, or V8's SyntaxError compiling a regex. */
export type Overflow = RangeError | SyntaxError;

function isOverflow(error: unknown): error is Overflow {
  return (
    error instanceof RangeError ||
    (error instanceof SyntaxError && error.message.endsWith("Stack overflow"))
  );
}

/**
 * `run` called at every level of a recursion as deep as the stack allows, from
 * the bottom up: what each call returned, or the overflow it threw. The first
 * calls, with no stack left to enter `run` at all, throw whatever `run` does;
 * every call after the first that returns has more stack than that one had.
 */
export function upFromStackBottom<T>(run: () => T): (T | Overflow)[] {
  const results: (T | Overflow)[] = [];
  const down = (): void => {
    try {
      down();
    } catch (error) {
      if (!isOverflow(error)) throw error;
    }
    try {
      results.push(run());
    } catch (error) {
      if (!isOverflow(error)) throw error;
      results.push(error);
    }
  };
  down();
  return results;
}

/** The calls from the first that returned on, which must all have returned. */
export function afterFirstReturn<T>(results: (T | Overflow)[]): T[] {
  const first = results.findIndex((result) => !isOverflow(result));
  const rest = results.slice(first);
  if (first < 0 || rest.some(isOverflow)) {
    throw new Error("a call threw with more stack than one that returned");
  }
  return rest as T[];
}
