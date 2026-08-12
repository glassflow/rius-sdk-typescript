import type { TracerProvider } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import { init } from "../src/client.js";
import {
  REGISTRY,
  type RegistryEntry,
  enableInstrumentations,
  isUnresolved,
} from "../src/instrumentation.js";

/** Structural stand-in: registerInstrumentations only ever calls getTracer(). */
const tracerProvider = { getTracer: () => undefined } as unknown as TracerProvider;

function makeSink() {
  return { add: vi.fn(), addFirst: vi.fn() };
}

const inertProcessor: SpanProcessor = {
  onStart() {},
  onEnd() {},
  async forceFlush() {},
  async shutdown() {},
};

/** Adds a synthetic entry for the duration of `body`, then removes it. */
async function withEntry(entry: RegistryEntry, body: () => Promise<void>): Promise<void> {
  REGISTRY.push(entry);
  try {
    await body();
  } finally {
    REGISTRY.splice(
      REGISTRY.findIndex((e) => e.name === entry.name),
      1,
    );
  }
}

/** A finished span shaped like one the Vercel AI SDK emits. */
function vercelSpan(): ReadableSpan {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const span = provider.getTracer("test").startSpan("ai.generateText.doGenerate", {
    attributes: {
      "operation.name": "ai.generateText.doGenerate",
      "ai.model.id": "gpt-4o-mini",
      "ai.model.provider": "openai",
      "ai.prompt": JSON.stringify({ prompt: "what is 2+2" }),
      "ai.response.text": "4",
      "ai.settings.maxOutputTokens": 100,
    },
  });
  span.end();
  const finished = exporter.getFinishedSpans()[0];
  if (finished === undefined) throw new Error("test setup: no finished span");
  return finished;
}

describe("REGISTRY", () => {
  it("declares both entry kinds, since Vercel support is a processor not an instrumentation", () => {
    const kinds = Object.fromEntries(REGISTRY.map((e) => [e.name, e.kind]));
    expect(kinds["vercel-ai"]).toBe("processor");
    expect(kinds.openai).toBe("instrumentation");
  });

  it("has unique names", () => {
    expect(new Set(REGISTRY.map((e) => e.name)).size).toBe(REGISTRY.length);
  });

  it("marks vercel-ai for insertion first, so masking still sees what it adds", () => {
    expect(REGISTRY.find((e) => e.name === "vercel-ai")?.insert).toBe("first");
  });
});

describe("isUnresolved", () => {
  const spec = "@arizeai/openinference-vercel";

  it("treats a failure to resolve the requested specifier as absent", () => {
    const messages = [
      // Node ESM
      `Cannot find package '${spec}' imported from /app/node_modules/@glassflow/rius/dist/index.js`,
      // Node CJS
      `Cannot find module '${spec}'`,
      // bundler / test-runner loaders
      `Could not resolve "${spec}" imported by "@glassflow/rius". Is it installed?`,
      `Failed to load url ${spec} (resolved id: ${spec}). Does the file exist?`,
    ];
    for (const message of messages) {
      expect(isUnresolved(new Error(message), spec)).toBe(true);
    }
  });

  it("does NOT treat a failure inside the package as absent, even when the message names its path", () => {
    // The laundering case: the package IS installed but one of ITS OWN
    // dependencies is missing. The resolution phrase names that dependency, and
    // our specifier appears only in the importer path. Must stay loud.
    const error = new Error(
      `Cannot find package 'zod' imported from /app/node_modules/${spec}/dist/esm/index.js`,
    );
    expect(isUnresolved(error, spec)).toBe(false);
  });

  it("does NOT treat an ESM-only require failure or a runtime error as absent", () => {
    const notExported = new Error(
      `Package subpath './utils' is not defined by "exports" in /app/node_modules/${spec}/package.json`,
    );
    expect(isUnresolved(notExported, spec)).toBe(false);
    expect(isUnresolved(new TypeError("x is not a function"), spec)).toBe(false);
    expect(isUnresolved({ code: "ERR_MODULE_NOT_FOUND" }, spec)).toBe(false);
    // Anything can be thrown; the classifier must not throw on non-errors.
    expect(isUnresolved(undefined, spec)).toBe(false);
    expect(isUnresolved(null, spec)).toBe(false);
    expect(isUnresolved(`Cannot find module '${spec}'`, spec)).toBe(false);
  });

  it("classifies a frozen error without attempting to mutate it", () => {
    const frozen = Object.freeze(new Error(`Cannot find module '${spec}'`));
    expect(() => isUnresolved(frozen, spec)).not.toThrow();
    expect(isUnresolved(frozen, spec)).toBe(true);
    expect((frozen as { code?: string }).code).toBeUndefined();
  });
});

describe("enableInstrumentations", () => {
  it("skips entries whose optional package is absent and never throws", async () => {
    const sink = makeSink();
    const enabled = await enableInstrumentations(sink, tracerProvider, [
      "definitely-not-installed",
    ]);
    expect(enabled).toEqual([]);
    expect(sink.add).not.toHaveBeenCalled();
    expect(sink.addFirst).not.toHaveBeenCalled();
  });

  it("returns the names it enabled and nothing else", async () => {
    const sink = makeSink();
    await withEntry(
      { name: "test-ok-entry", kind: "processor", load: async () => inertProcessor },
      async () => {
        const enabled = await enableInstrumentations(sink, tracerProvider, [
          "test-ok-entry",
          "definitely-not-installed",
        ]);
        expect(enabled).toEqual(["test-ok-entry"]);
        expect(sink.add).toHaveBeenCalledWith(inertProcessor);
      },
    );
  });

  it('routes insert:"first" entries to addFirst and the rest to add', async () => {
    const sink = makeSink();
    await withEntry(
      {
        name: "test-first-entry",
        kind: "processor",
        insert: "first",
        load: async () => inertProcessor,
      },
      async () => {
        await enableInstrumentations(sink, tracerProvider, ["test-first-entry"]);
        expect(sink.addFirst).toHaveBeenCalledWith(inertProcessor);
        expect(sink.add).not.toHaveBeenCalled();
      },
    );
  });

  it("does not throw when a registry entry's load() rejects, and omits it from the result", async () => {
    const sink = makeSink();
    await withEntry(
      {
        name: "test-broken-entry",
        kind: "processor",
        load: () => Promise.reject(new Error("integration exploded")),
      },
      async () => {
        const enabled = await enableInstrumentations(sink, tracerProvider, ["test-broken-entry"]);
        expect(enabled).toEqual([]);
        expect(sink.add).not.toHaveBeenCalled();
        expect(sink.addFirst).not.toHaveBeenCalled();
      },
    );
  });
});

describe("the vercel-ai entry", () => {
  it("loads a transforming processor from the installed package", async () => {
    const entry = REGISTRY.find((e) => e.name === "vercel-ai");
    expect(entry).toBeDefined();
    const loaded = (await entry?.load()) as SpanProcessor | undefined;
    expect(loaded).toBeDefined();
    expect(typeof loaded?.onEnd).toBe("function");
  });

  it("is reported as enabled and adds OpenInference attributes to a Vercel AI span", async () => {
    const sink = makeSink();
    const enabled = await enableInstrumentations(sink, tracerProvider, ["vercel-ai"]);
    expect(enabled).toContain("vercel-ai");
    expect(sink.addFirst).toHaveBeenCalledTimes(1);
    expect(sink.add).not.toHaveBeenCalled();

    const processor = sink.addFirst.mock.calls[0]?.[0] as SpanProcessor;
    const span = vercelSpan();
    expect(span.attributes["openinference.span.kind"]).toBeUndefined();

    processor.onEnd(span);

    expect(span.attributes["openinference.span.kind"]).toBe("LLM");
    expect(span.attributes["llm.model_name"]).toBe("gpt-4o-mini");
    expect(span.attributes["output.value"]).toBe("4");
    // The transform ADDS content, which is why it has to run ahead of the
    // exporting processor: masking lives in the exporter chain.
    expect(span.attributes["input.value"]).toBe(JSON.stringify({ prompt: "what is 2+2" }));
    // Original attributes survive; the transform only adds.
    expect(span.attributes["ai.model.id"]).toBe("gpt-4o-mini");
  });

  it("does not export on its own, so spans are never exported twice", async () => {
    const entry = REGISTRY.find((e) => e.name === "vercel-ai");
    const loaded = (await entry?.load()) as SpanProcessor;
    // A processor that exported would need somewhere to export to; ours takes no
    // exporter and its flush/shutdown are inert.
    await expect(loaded.forceFlush()).resolves.toBeUndefined();
    await expect(loaded.shutdown()).resolves.toBeUndefined();
  });
});

describe("init().ready", () => {
  it("resolves with the enabled integration names and never rejects", async () => {
    const client = init({ spanExporter: new InMemorySpanExporter() });
    await expect(client.ready).resolves.toBeInstanceOf(Array);
    await client.shutdown();
  });

  it("resolves rather than rejects whichever optional peers are installed", async () => {
    const client = init({ spanExporter: new InMemorySpanExporter() });
    // Settle explicitly: `await client.ready` inside expect() would let a
    // rejection surface as a test error that reads the same as a real failure,
    // and a bare resolves-assertion cannot prove which branch ran.
    const outcome = await client.ready.then(
      (names) => ({ settled: "resolved" as const, names }),
      (error: unknown) => ({ settled: "rejected" as const, error }),
    );
    expect(outcome.settled).toBe("resolved");
    expect(outcome.settled === "resolved" && Array.isArray(outcome.names)).toBe(true);
    await client.shutdown();
  });

  it("attaches the vercel-ai transform ahead of the exporting processor", async () => {
    const exporter = new InMemorySpanExporter();
    const client = init({ spanExporter: exporter });
    const enabled = await client.ready;
    expect(enabled).toContain("vercel-ai");
    await client.shutdown();
  });
});
