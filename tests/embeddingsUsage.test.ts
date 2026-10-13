import { type Span, context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installEmbeddingsUsage, recordEmbeddingsUsageOn } from "../src/embeddingsUsage.js";

// The wrapper on its own, against a stand-in for the OpenAI client class: what
// it records, on which span, and how it installs and uninstalls. The real
// client and instrumentation are exercised in openaiEmbeddingsUsage.test.ts.

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const tracer = provider.getTracer("test");
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
});

afterAll(() => {
  context.disable();
});

beforeEach(() => {
  exporter.reset();
});

const RESPONSE = {
  object: "list",
  data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
  model: "text-embedding-3-small",
  usage: { prompt_tokens: 5, total_tokens: 5 },
};

/** A fresh stand-in for the client module: `{ OpenAI }` with an Embeddings class. */
function fakeModule(create: (...args: unknown[]) => unknown = async () => RESPONSE) {
  class Embeddings {
    create(...args: unknown[]): unknown {
      return create(...args);
    }
  }
  return { OpenAI: { Embeddings } };
}

/** Run `call` inside an active span with `attributes`, end it, return it. */
async function inSpan(
  attributes: Record<string, string>,
  call: () => unknown,
): Promise<{ span: ReadableSpan; result: unknown }> {
  let result: unknown;
  await tracer.startActiveSpan("call", { attributes }, async (span: Span) => {
    result = await call();
    span.end();
  });
  const span = exporter.getFinishedSpans().at(-1);
  if (span === undefined) throw new Error("no span");
  return { span, result };
}

const EMBEDDING = { "openinference.span.kind": "EMBEDDING" };

describe("installEmbeddingsUsage", () => {
  it("records the response's token counts on the active embedding span", async () => {
    const module = fakeModule();
    installEmbeddingsUsage(module);
    const client = new module.OpenAI.Embeddings();
    const { span, result } = await inSpan(EMBEDDING, () => client.create({ input: "hi" }));
    expect(result).toBe(RESPONSE);
    expect(span.attributes["llm.token_count.prompt"]).toBe(5);
    expect(span.attributes["llm.token_count.total"]).toBe(5);
  });

  it("leaves any other span alone", async () => {
    const module = fakeModule();
    installEmbeddingsUsage(module);
    const client = new module.OpenAI.Embeddings();
    const { span } = await inSpan({ "openinference.span.kind": "LLM" }, () =>
      client.create({ input: "hi" }),
    );
    expect(span.attributes["llm.token_count.prompt"]).toBeUndefined();
  });

  it("does nothing without an active span", async () => {
    const module = fakeModule();
    installEmbeddingsUsage(module);
    await expect(new module.OpenAI.Embeddings().create({})).resolves.toBe(RESPONSE);
  });

  it("keeps the instrumentor's thenable: an APIPromise stays one", async () => {
    let unwrapped = false;
    const apiPromise = {
      _thenUnwrap(fn: (data: unknown) => unknown) {
        unwrapped = true;
        return Promise.resolve(RESPONSE).then(fn);
      },
    };
    const module = fakeModule(() => apiPromise);
    installEmbeddingsUsage(module);
    const client = new module.OpenAI.Embeddings();
    const { span } = await inSpan(EMBEDDING, () => client.create({}));
    expect(unwrapped).toBe(true);
    expect(span.attributes["llm.token_count.prompt"]).toBe(5);
  });

  it("returns a non-promise result untouched", async () => {
    const plain = { not: "a promise" };
    const module = fakeModule(() => plain);
    installEmbeddingsUsage(module);
    const client = new module.OpenAI.Embeddings();
    const { result } = await inSpan(EMBEDDING, () => client.create({}));
    expect(result).toBe(plain);
  });

  it("never breaks the call when the response is unreadable", async () => {
    const hostile = {
      get usage(): never {
        throw new Error("boom");
      },
    };
    const module = fakeModule(async () => hostile);
    installEmbeddingsUsage(module);
    const client = new module.OpenAI.Embeddings();
    const { result, span } = await inSpan(EMBEDDING, () => client.create({}));
    expect(result).toBe(hostile);
    expect(span.attributes["llm.token_count.prompt"]).toBeUndefined();
  });

  it("uninstalls, restoring the client's own method", () => {
    const module = fakeModule();
    const prototype = module.OpenAI.Embeddings.prototype;
    const own = prototype.create;
    const uninstall = installEmbeddingsUsage(module);
    expect(prototype.create).not.toBe(own);
    uninstall();
    expect(prototype.create).toBe(own);
  });

  it("is reused, not stacked, when found under another wrapper", async () => {
    const module = fakeModule();
    const prototype = module.OpenAI.Embeddings.prototype as unknown as Record<string, unknown>;
    const uninstall = installEmbeddingsUsage(module);
    const ours = prototype.create as (...args: unknown[]) => unknown;
    // An instrumentation wrapping on top, shimmer-style.
    const outer = Object.assign((...args: unknown[]) => ours.apply(undefined, args), {
      __original: ours,
    });
    prototype.create = outer;
    // shutdown(): ours is deactivated but cannot be removed from under the outer one.
    uninstall();
    expect(prototype.create).toBe(outer);
    const { span: off } = await inSpan(EMBEDDING, () =>
      (prototype.create as (...a: unknown[]) => unknown)({}),
    );
    expect(off.attributes["llm.token_count.prompt"]).toBeUndefined();
    // The next init(): reactivated where it is, nothing new installed.
    installEmbeddingsUsage(module);
    expect(prototype.create).toBe(outer);
    const { span: on } = await inSpan(EMBEDDING, () =>
      (prototype.create as (...a: unknown[]) => unknown)({}),
    );
    expect(on.attributes["llm.token_count.prompt"]).toBe(5);
  });

  it("does not install on top of someone else's wrapper", () => {
    const module = fakeModule();
    const prototype = module.OpenAI.Embeddings.prototype as unknown as Record<string, unknown>;
    const foreign = Object.assign(() => undefined, { __original: prototype.create });
    prototype.create = foreign;
    installEmbeddingsUsage(module);
    expect(prototype.create).toBe(foreign);
  });

  it("ignores a module without an embeddings class", () => {
    expect(() => installEmbeddingsUsage({ OpenAI: {} })()).not.toThrow();
  });
});

describe("recordEmbeddingsUsageOn", () => {
  it("leaves a count the instrumentor already recorded", async () => {
    const { span } = await inSpan(EMBEDDING, () => {
      const active = trace.getActiveSpan() as Span;
      active.setAttribute("llm.token_count.prompt", 7);
      recordEmbeddingsUsageOn(active, RESPONSE);
    });
    expect(span.attributes["llm.token_count.prompt"]).toBe(7);
    expect(span.attributes["llm.token_count.total"]).toBe(5);
  });

  it("records only whole, non-negative counts", async () => {
    const { span } = await inSpan(EMBEDDING, () => {
      recordEmbeddingsUsageOn(trace.getActiveSpan() as Span, {
        usage: { prompt_tokens: "5", total_tokens: -1 },
      });
    });
    expect(span.attributes["llm.token_count.prompt"]).toBeUndefined();
    expect(span.attributes["llm.token_count.total"]).toBeUndefined();
  });
});
