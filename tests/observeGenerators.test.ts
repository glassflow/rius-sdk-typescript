import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { init, type RiusClient } from "../src/client.js";
import { observe } from "../src/observe.js";
import { SpanKind } from "../src/semconv.js";
import { startAsCurrentSpan } from "../src/spans.js";

// A wrapped generator's span covers the whole iteration, as the Python SDK's
// does: it opens on the first step, ends when the iteration finishes, fails or
// is closed, and the span is current only while the generator's own code runs.

let exporter: InMemorySpanExporter;
let client: RiusClient;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  client = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
});
afterEach(async () => {
  await client.shutdown();
});

async function finished() {
  await client.flush();
  return exporter.getFinishedSpans();
}

describe("observe on a generator function", () => {
  it("returns a generator, not a Promise, and yields what the original yields", async () => {
    const observedCount = observe(function* count(n: number) {
      for (let i = 0; i < n; i++) yield i;
    });
    const iterator = observedCount(3);
    expect(typeof (iterator as unknown as { then?: unknown }).then).toBe("undefined");
    expect([...iterator]).toEqual([0, 1, 2]);
    const spans = await finished();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("count");
    expect(spans[0].attributes["input.value"]).toBe('{"args":[3],"kwargs":{}}');
  });

  it("keeps the span open until the iteration finishes", async () => {
    const observedStream = observe(function* stream() {
      yield 1;
      yield 2;
    });
    const iterator = observedStream();
    iterator.next();
    expect(await finished()).toHaveLength(0);
    iterator.next();
    iterator.next();
    expect(await finished()).toHaveLength(1);
  });

  it("opens no span until the first step, like the Python SDK", async () => {
    const observedStream = observe(function* stream() {
      yield 1;
    });
    observedStream();
    expect(await finished()).toHaveLength(0);
  });

  it("records no output, as the Python SDK records none for a generator", async () => {
    const observedStream = observe(function* stream() {
      yield "a";
      return "done";
    });
    const iterator = observedStream();
    expect(iterator.next()).toEqual({ value: "a", done: false });
    // The generator's own return value still reaches the caller.
    expect(iterator.next()).toEqual({ value: "done", done: true });
    expect((await finished())[0].attributes["output.value"]).toBeUndefined();
  });

  it("records an error raised mid-iteration and rethrows it", async () => {
    const observedBoom = observe(function* boom() {
      yield 1;
      throw new RangeError("mid-stream");
    });
    expect(() => [...observedBoom()]).toThrow("mid-stream");
    const span = (await finished())[0];
    expect(span.status.code).toBe(2);
    expect(span.attributes["error.type"]).toBe("RangeError");
    expect(span.events.filter((e) => e.name === "exception")).toHaveLength(1);
  });

  it("closes the inner generator and ends the span on break", async () => {
    let cleanedUp = false;
    const observedStream = observe(function* stream() {
      try {
        yield 1;
        yield 2;
      } finally {
        cleanedUp = true;
      }
    });
    for (const _ of observedStream()) break;
    expect(cleanedUp).toBe(true);
    const span = (await finished())[0];
    expect(span.status.code).not.toBe(2);
  });

  it("records an error the inner generator's finally throws on break", async () => {
    const observedStream = observe(function* stream() {
      try {
        yield 1;
        yield 2;
      } finally {
        // biome-ignore lint/correctness/noUnsafeFinally: the case under test.
        throw new TypeError("cleanup failed");
      }
    });
    expect(() => {
      for (const _ of observedStream()) break;
    }).toThrow("cleanup failed");
    const spans = await finished();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(2);
    expect(spans[0].attributes["error.type"]).toBe("TypeError");
    expect(spans[0].events.filter((e) => e.name === "exception")).toHaveLength(1);
  });

  it("forwards the caller's next() argument and throw() to the inner generator", async () => {
    const received: unknown[] = [];
    const observedEcho = observe(function* echo() {
      try {
        received.push(yield "first");
      } catch (error) {
        received.push((error as Error).message);
      }
      received.push(yield "second");
    });
    const iterator = observedEcho();
    iterator.next();
    expect(iterator.throw(new Error("from caller"))).toEqual({ value: "second", done: false });
    iterator.next("sent");
    expect(received).toEqual(["from caller", "sent"]);
    expect((await finished())[0].attributes["error.type"]).toBeUndefined();
  });

  it("records a caller's throw() the generator does not handle", async () => {
    const observedStream = observe(function* stream() {
      yield 1;
    });
    const iterator = observedStream();
    iterator.next();
    expect(() => iterator.throw(new TypeError("stop"))).toThrow("stop");
    expect((await finished())[0].attributes["error.type"]).toBe("TypeError");
  });

  it("is current inside the generator body, never in the caller between steps", async () => {
    const tracer = trace.getTracer("test");
    const observedStream = observe(function* stream() {
      const inner = tracer.startSpan("inner-work");
      inner.end();
      yield 1;
      yield 2;
    });
    const iterator = observedStream();
    iterator.next();
    expect(trace.getActiveSpan()).toBeUndefined();
    tracer.startSpan("caller-work").end();
    iterator.next();
    iterator.next();
    const spans = await finished();
    const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
    expect(byName["inner-work"].parentSpanContext?.spanId).toBe(byName.stream.spanContext().spanId);
    expect(byName["caller-work"].parentSpanContext).toBeUndefined();
  });

  it("composes a TOOL name from the generator function, as the other wrappers do", async () => {
    const observedLookup = observe(
      function* lookup() {
        yield 1;
      },
      { kind: SpanKind.TOOL },
    );
    [...observedLookup()];
    const span = (await finished())[0];
    expect(span.name).toBe("execute_tool lookup");
    expect(span.attributes["gen_ai.tool.name"]).toBe("lookup");
  });

  it("keeps the receiver of a wrapped generator method", async () => {
    const holder = {
      items: [7, 8],
      list: observe(function* list(this: { items: number[] }) {
        yield* this.items;
      }),
    };
    expect([...holder.list()]).toEqual([7, 8]);
  });

  it("records and ends the span when the generator's parameters throw", async () => {
    // Destructuring and default values run when the generator function is
    // called, before its body, so they fail on the wrapper's first step.
    const observedGen = observe(function* gen({ n }: { n: number }) {
      yield n;
    });
    expect(() => observedGen(undefined as never).next()).toThrow(TypeError);
    const spans = await finished();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(2);
    expect(spans[0].attributes["error.type"]).toBe("TypeError");
    expect(spans[0].events.filter((e) => e.name === "exception")).toHaveLength(1);
  });
});

describe("observe on an async generator function", () => {
  it("returns an async generator whose span covers the iteration", async () => {
    const observedTokens = observe(async function* tokens(prefix: string) {
      yield `${prefix}1`;
      await new Promise((resolve) => setTimeout(resolve, 1));
      yield `${prefix}2`;
    });
    const seen: string[] = [];
    for await (const token of observedTokens("t")) seen.push(token);
    expect(seen).toEqual(["t1", "t2"]);
    const spans = await finished();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("tokens");
    expect(spans[0].attributes["input.value"]).toBe('{"args":["t"],"kwargs":{}}');
    expect(spans[0].attributes["output.value"]).toBeUndefined();
  });

  it("keeps the span open between steps", async () => {
    const observedStream = observe(async function* stream() {
      yield 1;
      yield 2;
    });
    const iterator = observedStream();
    await iterator.next();
    expect(await finished()).toHaveLength(0);
    await iterator.next();
    await iterator.next();
    expect(await finished()).toHaveLength(1);
  });

  it("records an error raised mid-iteration and rethrows it", async () => {
    const observedBoom = observe(async function* boom() {
      yield 1;
      await Promise.resolve();
      throw new RangeError("async mid-stream");
    });
    await expect(
      (async () => {
        for await (const _ of observedBoom()) {
        }
      })(),
    ).rejects.toThrow("async mid-stream");
    const span = (await finished())[0];
    expect(span.status.code).toBe(2);
    expect(span.attributes["error.type"]).toBe("RangeError");
  });

  it("closes the inner generator and ends the span on break", async () => {
    let cleanedUp = false;
    const observedStream = observe(async function* stream() {
      try {
        yield 1;
        yield 2;
      } finally {
        cleanedUp = true;
      }
    });
    for await (const _ of observedStream()) break;
    expect(cleanedUp).toBe(true);
    expect(await finished()).toHaveLength(1);
  });

  it("records an error the inner generator's finally throws on break", async () => {
    const observedStream = observe(async function* stream() {
      try {
        yield 1;
        yield 2;
      } finally {
        // biome-ignore lint/correctness/noUnsafeFinally: the case under test.
        throw new TypeError("cleanup failed");
      }
    });
    await expect(async () => {
      for await (const _ of observedStream()) break;
    }).rejects.toThrow("cleanup failed");
    const spans = await finished();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(2);
    expect(spans[0].attributes["error.type"]).toBe("TypeError");
    expect(spans[0].events.filter((e) => e.name === "exception")).toHaveLength(1);
  });

  it("nests spans opened across awaits in the body, and none opened by the caller", async () => {
    const tracer = trace.getTracer("test");
    const observedStream = observe(async function* stream() {
      await new Promise((resolve) => setTimeout(resolve, 1));
      tracer.startSpan("inner-work").end();
      yield 1;
      yield 2;
    });
    const iterator = observedStream();
    await iterator.next();
    tracer.startSpan("caller-work").end();
    await iterator.next();
    await iterator.next();
    const byName = Object.fromEntries((await finished()).map((s) => [s.name, s]));
    expect(byName["inner-work"].parentSpanContext?.spanId).toBe(byName.stream.spanContext().spanId);
    expect(byName["caller-work"].parentSpanContext).toBeUndefined();
  });

  it("scopes an AGENT generator over the TOOL spans opened inside it", async () => {
    const tool = observe(async () => 1, { kind: SpanKind.TOOL, toolName: "search" });
    const agent = observe(
      async function* plan() {
        await tool();
        yield 1;
      },
      { kind: SpanKind.AGENT, agentName: "planner" },
    );
    for await (const _ of agent()) {
    }
    const byName = Object.fromEntries((await finished()).map((s) => [s.name, s]));
    expect(byName["invoke_agent planner"]).toBeDefined();
    expect(byName["execute_tool search"].attributes["gen_ai.agent.name"]).toBe("planner");
  });

  it("parents to the span current at the first step", async () => {
    const observedStream = observe(async function* stream() {
      yield 1;
    });
    let outerId: string | undefined;
    await startAsCurrentSpan("outer", async (observation) => {
      outerId = observation.span.spanContext().spanId;
      for await (const _ of observedStream()) {
      }
    });
    const byName = Object.fromEntries((await finished()).map((s) => [s.name, s]));
    expect(byName.stream.parentSpanContext?.spanId).toBe(outerId);
  });

  it("records and ends the span when the generator's default value throws", async () => {
    const fail = (): number => {
      throw new RangeError("bad default");
    };
    const observedGen = observe(async function* gen(n: number = fail()) {
      yield n;
    });
    await expect(observedGen().next()).rejects.toThrow("bad default");
    const spans = await finished();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(2);
    expect(spans[0].attributes["error.type"]).toBe("RangeError");
    expect(spans[0].events.filter((e) => e.name === "exception")).toHaveLength(1);
  });
});

describe("observe's return type", () => {
  it("is the generator for a generator function and a Promise otherwise", () => {
    const gen = observe(function* gen(n: number) {
      yield n;
      return "r";
    });
    expectTypeOf(gen).returns.toEqualTypeOf<Generator<number, string, unknown>>();
    const agen = observe(async function* agen() {
      yield 1;
    });
    expectTypeOf(agen).returns.toEqualTypeOf<AsyncGenerator<number, void, unknown>>();
    expectTypeOf(observe(async (s: string) => s.length)).returns.toEqualTypeOf<Promise<number>>();
    expectTypeOf(observe((a: number) => a)).returns.toEqualTypeOf<Promise<number>>();
    // `any` must not be mistaken for a generator: untyped callbacks keep the
    // Promise they always had.
    // biome-ignore lint/suspicious/noExplicitAny: the case under test.
    expectTypeOf(observe((x: any) => x)).returns.toEqualTypeOf<Promise<any>>();
  });

  it("is the declared iteration type for a generator function annotated with one", () => {
    // Annotating a generator with the iteration interface it implements is
    // common; the wrapper still returns a generator, so it is not a Promise.
    async function* asyncIterable(): AsyncIterable<string> {
      yield "a";
    }
    async function* asyncIterableIterator(): AsyncIterableIterator<string> {
      yield "a";
    }
    function* iterable(): Iterable<number> {
      yield 1;
    }
    function* iterableIterator(): IterableIterator<number> {
      yield 1;
    }
    expectTypeOf(observe(asyncIterable)).returns.toEqualTypeOf<AsyncIterable<string>>();
    expectTypeOf(observe(asyncIterableIterator)).returns.toEqualTypeOf<
      AsyncIterableIterator<string>
    >();
    expectTypeOf(observe(iterable)).returns.toEqualTypeOf<Iterable<number>>();
    expectTypeOf(observe(iterableIterator)).returns.toEqualTypeOf<IterableIterator<number>>();
  });

  it("stays a Promise for a plain function returning an iterable collection", () => {
    // Only a generator function is detected at runtime, so a function that
    // returns an array, a string, a Set or a Map keeps its Promise.
    expectTypeOf(observe(() => [1, 2])).returns.toEqualTypeOf<Promise<number[]>>();
    expectTypeOf(observe((): readonly number[] => [1])).returns.toEqualTypeOf<
      Promise<readonly number[]>
    >();
    expectTypeOf(observe(() => "text")).returns.toEqualTypeOf<Promise<string>>();
    expectTypeOf(observe(() => new Set([1]))).returns.toEqualTypeOf<Promise<Set<number>>>();
    expectTypeOf(observe(() => new Map([[1, "a"]]))).returns.toEqualTypeOf<
      Promise<Map<number, string>>
    >();
  });

  it("is a Promise of never for a function that only throws", () => {
    // `never` would otherwise satisfy the generator arm and type the wrapper
    // of a function that always throws as an async generator.
    const fail = (): never => {
      throw new Error("always");
    };
    expectTypeOf(observe(fail)).returns.toEqualTypeOf<Promise<never>>();
  });

  it("pins the documented caveats a type cannot see past", () => {
    // A built-in iterator is exactly an iteration interface to the type
    // system, so a plain function returning one is typed as that iterator,
    // although its wrapper returns a Promise at runtime.
    expectTypeOf(observe(() => [1].values())).returns.toEqualTypeOf<ArrayIterator<number>>();
    expectTypeOf(observe(() => new Map([[1, "a"]]).entries())).returns.toEqualTypeOf<
      MapIterator<[number, string]>
    >();
    expectTypeOf(observe(() => new Set([1]).values())).returns.toEqualTypeOf<SetIterator<number>>();
    expectTypeOf(observe((s: string) => s.matchAll(/a/g))).returns.toEqualTypeOf<
      RegExpStringIterator<RegExpExecArray>
    >();
    // A union is not split, so a generator function annotated with an
    // iteration interface or undefined is typed as a Promise, although its
    // wrapper returns a generator at runtime.
    function* maybe(): Iterable<number> | undefined {
      yield 1;
    }
    expectTypeOf(observe(maybe)).returns.toEqualTypeOf<Promise<Iterable<number> | undefined>>();
  });
});

describe("observe on a generator function annotated with an iteration interface", () => {
  it("returns a generator with no then(), for an async generator", async () => {
    const observedStream = observe(async function* stream(): AsyncIterable<string> {
      yield "a";
      yield "b";
    });
    const iterator = observedStream();
    // @ts-expect-error a generator is not a Promise, so then() is not there.
    const then: unknown = iterator.then;
    expect(then).toBeUndefined();
    const chunks: string[] = [];
    for await (const chunk of iterator) chunks.push(chunk);
    expect(chunks).toEqual(["a", "b"]);
    const spans = await finished();
    expect(spans.map((s) => s.name)).toEqual(["stream"]);
  });

  it("returns a generator with no then(), for a generator", async () => {
    const observedCount = observe(function* count(): IterableIterator<number> {
      yield 1;
      yield 2;
    });
    const iterator = observedCount();
    // @ts-expect-error a generator is not a Promise, so then() is not there.
    const then: unknown = iterator.then;
    expect(then).toBeUndefined();
    expect([...iterator]).toEqual([1, 2]);
    expect((await finished()).map((s) => s.name)).toEqual(["count"]);
  });

  it("returns a Promise for a plain function returning an array", async () => {
    const list = observe(() => [1, 2]);
    const result = list();
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toEqual([1, 2]);
  });
});
