import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { TracerProvider } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RiusClient, getTracer, init, spanProcessorSink } from "../src/client.js";
import {
  REGISTRY,
  type RegistryEntry,
  enableInstrumentations,
  isUnresolved,
  optional,
  readDeclaredDependencies,
} from "../src/instrumentation.js";

// init() hands back the existing client while one is active, so a client that
// is never shut down silently becomes every later test's client. A test body
// that fails part way through — a timeout in particular, which vitest cannot
// abort — would otherwise leave one behind and take the rest of the file down
// with it, each failure looking like its own bug.
let live: RiusClient | undefined;

/** init(), remembered so the teardown can release it if the test does not. */
function initTracked(options: Parameters<typeof init>[0] = {}): RiusClient {
  live = init(options);
  return live;
}

afterEach(async () => {
  const client = live;
  live = undefined;
  await client?.shutdown().catch(() => {});
});

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

/** Silences and records console.warn. Callers must mockRestore in a finally. */
function spyOnWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

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

/** A scratch directory holding the given files, removed by the returned cleanup. */
function scratchDir(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rius-instrumentation-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Attributes as the Vercel AI SDK sets them on a generateText span. */
const VERCEL_SPAN_ATTRIBUTES = {
  "operation.name": "ai.generateText.doGenerate",
  // The attribute the transform is gated on: every v5/v6 span carries it.
  "ai.operationId": "ai.generateText.doGenerate",
  "ai.model.id": "gpt-4o-mini",
  "ai.model.provider": "openai",
  "ai.prompt": JSON.stringify({ prompt: "what is 2+2" }),
  "ai.response.text": "4",
  "ai.settings.maxOutputTokens": 100,
};

/** A finished span shaped like one the Vercel AI SDK emits. */
function vercelSpan(): ReadableSpan {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const span = provider.getTracer("test").startSpan("ai.generateText.doGenerate", {
    attributes: VERCEL_SPAN_ATTRIBUTES,
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
    expect(kinds.anthropic).toBe("instrumentation");
    expect(kinds.langchain).toBe("instrumentation");
  });

  it("has unique names", () => {
    expect(new Set(REGISTRY.map((e) => e.name)).size).toBe(REGISTRY.length);
  });

  it("marks vercel-ai for insertion first, so masking still sees what it adds", () => {
    expect(REGISTRY.find((e) => e.name === "vercel-ai")?.insert).toBe("first");
  });

  it("names the package whose listing in package.json means the user wants anthropic or openai", () => {
    expect(REGISTRY.find((e) => e.name === "anthropic")?.optInPackage).toBe(
      "@arizeai/openinference-instrumentation-anthropic",
    );
    expect(REGISTRY.find((e) => e.name === "openai")?.optInPackage).toBe(
      "@arizeai/openinference-instrumentation-openai",
    );
  });
});

describe("readDeclaredDependencies", () => {
  it("reads the dependency names listed in the package.json of the given directory", () => {
    // vitest runs from the repo root, where this instrumentation is a devDependency.
    expect(readDeclaredDependencies(process.cwd())).toContain(
      "@arizeai/openinference-instrumentation-anthropic",
    );
  });

  it("returns an empty set, without throwing, when there is no package.json", () => {
    const declared = readDeclaredDependencies(join(process.cwd(), "no-such-dir"));
    expect(declared.size).toBe(0);
  });

  it("collects dependencies, devDependencies and optionalDependencies, and nothing else", () => {
    const { dir, cleanup } = scratchDir({
      "package.json": JSON.stringify({
        dependencies: { "pkg-dep": "1" },
        devDependencies: { "pkg-dev": "1" },
        optionalDependencies: { "pkg-optional": "1" },
        peerDependencies: { "pkg-peer": "1" },
      }),
    });
    try {
      expect([...readDeclaredDependencies(dir)].sort()).toEqual([
        "pkg-dep",
        "pkg-dev",
        "pkg-optional",
      ]);
    } finally {
      cleanup();
    }
  });

  it("ignores a dependency field that is not a plain object", () => {
    const { dir, cleanup } = scratchDir({
      "package.json": JSON.stringify({
        dependencies: ["pkg-in-array"],
        devDependencies: "pkg-in-string",
        optionalDependencies: null,
      }),
    });
    try {
      expect(readDeclaredDependencies(dir).size).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("isUnresolved", () => {
  const spec = "@arizeai/openinference-vercel";

  it("treats a failure to resolve the requested specifier as absent", () => {
    const messages = [
      // Node ESM
      `Cannot find package '${spec}' imported from /app/node_modules/@glassflow-ai/rius/dist/index.js`,
      // Node CJS
      `Cannot find module '${spec}'`,
      // bundler / test-runner loaders
      `Could not resolve "${spec}" imported by "@glassflow-ai/rius". Is it installed?`,
      `Failed to load url ${spec} (resolved id: ${spec}). Does the file exist?`,
    ];
    for (const message of messages) {
      expect(isUnresolved(new Error(message), spec)).toBe(true);
    }
  });

  it("treats a SUBPATH specifier as absent when the message names only the package", () => {
    // The case production actually hits: the vercel-ai entry imports
    // "<pkg>/utils", but Node's resolution error names only "<pkg>". Requiring
    // the full specifier warned every consumer who skipped the optional peer.
    const subpath = `${spec}/utils`;
    const messages = [
      `Cannot find package '${spec}' imported from /app/node_modules/@glassflow-ai/rius/dist/index.js`,
      `Cannot find module '${spec}'`,
      `Could not resolve "${spec}" imported by "@glassflow-ai/rius". Is it installed?`,
      // and still absent when the loader does echo the full subpath
      `Failed to load url ${subpath} (resolved id: ${subpath}). Does the file exist?`,
    ];
    for (const message of messages) {
      expect(isUnresolved(new Error(message), subpath)).toBe(true);
    }
  });

  it("does NOT treat a different package sharing our name as a prefix as absent", () => {
    // Without a right-hand boundary, "<pkg>" matches "<pkg>-nope" and a missing
    // sibling package is laundered into the quiet path.
    for (const requested of [spec, `${spec}/utils`]) {
      expect(isUnresolved(new Error(`Cannot find package '${spec}-nope'`), requested)).toBe(false);
      expect(
        isUnresolved(
          new Error(`Cannot find package '${spec}-nope' imported from /app/node_modules/x/i.js`),
          requested,
        ),
      ).toBe(false);
      expect(isUnresolved(new Error(`Cannot find module '${spec}2/utils'`), requested)).toBe(false);
    }
  });

  it("does NOT treat a failure inside the package as absent, even when the message names its path", () => {
    // The laundering case: the package IS installed but one of ITS OWN
    // dependencies is missing. The resolution phrase names that dependency, and
    // our specifier appears only in the importer path. Must stay loud.
    const error = new Error(
      `Cannot find package 'zod' imported from /app/node_modules/${spec}/dist/esm/index.js`,
    );
    // Both request forms, since the package alternative is now accepted: the
    // importer path must never be enough to call the package absent.
    expect(isUnresolved(error, spec)).toBe(false);
    expect(isUnresolved(error, `${spec}/utils`)).toBe(false);
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

  it("classifies the error the real loader throws for an absent scoped subpath", async () => {
    // Not a transcribed message: whatever the active loader actually throws for
    // a subpath import of a package that is not installed. This is the shape the
    // vercel-ai entry hits on every machine without the optional peer, and it is
    // the case a hand-written table missed.
    const absent = "@totally/absent-pkg/utils";
    let thrown: unknown = "nothing was thrown";
    try {
      await import(/* @vite-ignore */ absent);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBe("nothing was thrown");
    expect(isUnresolved(thrown, absent)).toBe(true);
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
        const warn = spyOnWarn();
        try {
          const enabled = await enableInstrumentations(sink, tracerProvider, ["test-broken-entry"]);
          expect(enabled).toEqual([]);
          expect(sink.add).not.toHaveBeenCalled();
          expect(sink.addFirst).not.toHaveBeenCalled();
        } finally {
          warn.mockRestore();
        }
      },
    );
  });
});

describe("enableInstrumentations diagnostics", () => {
  it("warns once naming the entry when load() throws, and still enables the others", async () => {
    const sink = makeSink();
    await withEntry(
      { name: "test-healthy-entry", kind: "processor", load: async () => inertProcessor },
      () =>
        withEntry(
          {
            name: "test-throwing-entry",
            kind: "self-applying",
            load: () => Promise.reject(new Error("prototype is not writable")),
          },
          async () => {
            const warn = spyOnWarn();
            try {
              const enabled = await enableInstrumentations(sink, tracerProvider, [
                "test-throwing-entry",
                "test-healthy-entry",
              ]);

              // One broken integration must not block the others.
              expect(enabled).toEqual(["test-healthy-entry"]);

              // A post-import failure is NOT silent: the user installed this peer
              // deliberately and would otherwise get nothing, with no explanation.
              expect(warn).toHaveBeenCalledTimes(1);
              const message = String(warn.mock.calls[0]?.[0]);
              expect(message).toContain("test-throwing-entry");
              expect(message).toContain("prototype is not writable");
              expect(message).not.toContain("test-healthy-entry");
            } finally {
              warn.mockRestore();
            }
          },
        ),
    );
  });

  it("stays quiet when load() resolves undefined, because that means absent", async () => {
    const sink = makeSink();
    await withEntry(
      { name: "test-absent-entry", kind: "processor", load: async () => undefined },
      async () => {
        const warn = spyOnWarn();
        try {
          const enabled = await enableInstrumentations(sink, tracerProvider, ["test-absent-entry"]);
          expect(enabled).toEqual([]);
          // The regression guard: warning here would make every consumer who
          // skipped an optional peer see noise at startup.
          expect(warn).not.toHaveBeenCalled();
        } finally {
          warn.mockRestore();
        }
      },
    );
  });

  it("warns once when load() resolves undefined for a package the app lists in package.json", async () => {
    const sink = makeSink();
    await withEntry(
      {
        name: "test-declared-entry",
        kind: "instrumentation",
        optInPackage: "test-declared-pkg",
        load: async () => undefined,
      },
      async () => {
        const warn = spyOnWarn();
        try {
          const enabled = await enableInstrumentations(
            sink,
            tracerProvider,
            ["test-declared-entry"],
            undefined,
            { declaredDependencies: () => new Set(["test-declared-pkg"]) },
          );
          expect(enabled).toEqual([]);
          expect(warn).toHaveBeenCalledTimes(1);
          const message = String(warn.mock.calls[0]?.[0]);
          expect(message).toContain("test-declared-entry");
          expect(message).toContain("test-declared-pkg");
          expect(message).toContain("instrumentModules");
        } finally {
          warn.mockRestore();
        }
      },
    );
  });

  it("stays quiet when the unloaded package is not listed in package.json", async () => {
    const sink = makeSink();
    await withEntry(
      {
        name: "test-declared-entry",
        kind: "instrumentation",
        optInPackage: "test-declared-pkg",
        load: async () => undefined,
      },
      async () => {
        const warn = spyOnWarn();
        try {
          const enabled = await enableInstrumentations(
            sink,
            tracerProvider,
            ["test-declared-entry"],
            undefined,
            { declaredDependencies: () => new Set() },
          );
          expect(enabled).toEqual([]);
          expect(warn).not.toHaveBeenCalled();
        } finally {
          warn.mockRestore();
        }
      },
    );
  });

  it("does not warn for a listed package that loaded", async () => {
    const sink = makeSink();
    await withEntry(
      {
        name: "test-declared-entry",
        kind: "processor",
        optInPackage: "test-declared-pkg",
        load: async () => inertProcessor,
      },
      async () => {
        const warn = spyOnWarn();
        try {
          const enabled = await enableInstrumentations(
            sink,
            tracerProvider,
            ["test-declared-entry"],
            undefined,
            { declaredDependencies: () => new Set(["test-declared-pkg"]) },
          );
          expect(enabled).toEqual(["test-declared-entry"]);
          expect(warn).not.toHaveBeenCalled();
        } finally {
          warn.mockRestore();
        }
      },
    );
  });

  it("warns once, not twice, when the listed package is installed but broken", async () => {
    // optional() already reports a package that is present but fails to load, so
    // the listed-but-unreachable warning on top of it would be a second line for
    // one problem.
    const { dir, cleanup } = scratchDir({ "broken.mjs": 'throw new Error("broken on import");' });
    try {
      const specifier = pathToFileURL(join(dir, "broken.mjs")).href;
      await withEntry(
        {
          name: "test-declared-entry",
          kind: "instrumentation",
          optInPackage: "test-declared-pkg",
          load: () => optional(specifier),
        },
        async () => {
          const warn = spyOnWarn();
          try {
            const enabled = await enableInstrumentations(
              makeSink(),
              tracerProvider,
              ["test-declared-entry"],
              undefined,
              { declaredDependencies: () => new Set(["test-declared-pkg"]) },
            );
            expect(enabled).toEqual([]);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0]?.[0])).toContain("broken on import");
          } finally {
            warn.mockRestore();
          }
        },
      );
    } finally {
      cleanup();
    }
  });

  it("stays quiet when reading the declared set throws, and reads it only once", async () => {
    const entry = (name: string): RegistryEntry => ({
      name,
      kind: "instrumentation",
      optInPackage: `${name}-pkg`,
      load: async () => undefined,
    });
    await withEntry(entry("test-declared-a"), () =>
      withEntry(entry("test-declared-b"), async () => {
        const warn = spyOnWarn();
        try {
          const declaredDependencies = vi.fn((): ReadonlySet<string> => {
            throw new Error("cannot read the working directory");
          });
          const enabled = await enableInstrumentations(
            makeSink(),
            tracerProvider,
            ["test-declared-a", "test-declared-b"],
            undefined,
            { declaredDependencies },
          );
          expect(enabled).toEqual([]);
          expect(warn).not.toHaveBeenCalled();
          expect(declaredDependencies).toHaveBeenCalledTimes(1);
        } finally {
          warn.mockRestore();
        }
      }),
    );
  });

  it("reads package.json at the working directory by default", async () => {
    const { dir, cleanup } = scratchDir({
      "package.json": JSON.stringify({ dependencies: { "test-declared-pkg": "1" } }),
    });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      await withEntry(
        {
          name: "test-declared-entry",
          kind: "instrumentation",
          optInPackage: "test-declared-pkg",
          load: async () => undefined,
        },
        async () => {
          const warn = spyOnWarn();
          try {
            await enableInstrumentations(makeSink(), tracerProvider, ["test-declared-entry"]);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0]?.[0])).toContain("test-declared-pkg");
          } finally {
            warn.mockRestore();
          }
        },
      );
    } finally {
      cwd.mockRestore();
      cleanup();
    }
  });

  it("stays quiet by default when the working directory is gone", async () => {
    const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory, uv_cwd");
    });
    try {
      await withEntry(
        {
          name: "test-declared-entry",
          kind: "instrumentation",
          optInPackage: "test-declared-pkg",
          load: async () => undefined,
        },
        async () => {
          const warn = spyOnWarn();
          try {
            const enabled = await enableInstrumentations(makeSink(), tracerProvider, [
              "test-declared-entry",
            ]);
            expect(enabled).toEqual([]);
            expect(warn).not.toHaveBeenCalled();
          } finally {
            warn.mockRestore();
          }
        },
      );
    } finally {
      cwd.mockRestore();
    }
  });

  it("reads the declared set at most once per call, and only when an entry needs it", async () => {
    const sink = makeSink();
    const entry = (name: string): RegistryEntry => ({
      name,
      kind: "instrumentation",
      optInPackage: `${name}-pkg`,
      load: async () => undefined,
    });
    await withEntry(entry("test-declared-a"), () =>
      withEntry(entry("test-declared-b"), async () => {
        const warn = spyOnWarn();
        try {
          const declaredDependencies = vi.fn(
            () => new Set(["test-declared-a-pkg", "test-declared-b-pkg"]),
          );
          await enableInstrumentations(
            sink,
            tracerProvider,
            ["test-declared-a", "test-declared-b"],
            undefined,
            { declaredDependencies },
          );
          expect(declaredDependencies).toHaveBeenCalledTimes(1);
          expect(warn).toHaveBeenCalledTimes(2);

          // Nothing unloaded, or nothing carrying an opt-in package: never read.
          declaredDependencies.mockClear();
          await enableInstrumentations(sink, tracerProvider, [], undefined, {
            declaredDependencies,
          });
          expect(declaredDependencies).not.toHaveBeenCalled();
        } finally {
          warn.mockRestore();
        }
      }),
    );
  });

  it("warns without throwing when load() rejects with a non-Error value", async () => {
    const sink = makeSink();
    await withEntry(
      {
        name: "test-nonerror-entry",
        kind: "processor",
        load: () => Promise.reject("just a string"),
      },
      async () => {
        const warn = spyOnWarn();
        try {
          await expect(
            enableInstrumentations(sink, tracerProvider, ["test-nonerror-entry"]),
          ).resolves.toEqual([]);
          expect(warn).toHaveBeenCalledTimes(1);
          const message = String(warn.mock.calls[0]?.[0]);
          expect(message).toContain("test-nonerror-entry");
          expect(message).toContain("just a string");
        } finally {
          warn.mockRestore();
        }
      },
    );
  });
});

// The @arizeai/openinference-vercel devDependency declares engines: >=22, and
// its own peers (ai, @ai-sdk/otel) target the same floor, so loading it on the
// Node 18 and 20 legs of the CI matrix is not expected to work. Only the tests
// that actually load the package are gated; everything else runs on every leg.
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
const describeWithVercelPackage = describe.skipIf(nodeMajor < 22);

describeWithVercelPackage("the vercel-ai entry", () => {
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
    const client = initTracked({
      spanExporter: new InMemorySpanExporter(),
      heartbeatTransport: async () => {},
    });
    await expect(client.ready).resolves.toBeInstanceOf(Array);
    await client.shutdown();
  });

  it("resolves rather than rejects whichever optional peers are installed", async () => {
    const client = initTracked({
      spanExporter: new InMemorySpanExporter(),
      heartbeatTransport: async () => {},
    });
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
});

describeWithVercelPackage("init() processor ordering", () => {
  it("gives the vercel-ai transform the span before the exporting processor", async () => {
    const client = initTracked({
      spanExporter: new InMemorySpanExporter(),
      heartbeatTransport: async () => {},
    });
    expect(await client.ready).toContain("vercel-ai");

    // A delegate appended with add() sits in the same relative position as the
    // exporting processor init() registered: after anything addFirst placed. If
    // it already sees the OpenInference attributes, the transform ran before the
    // exporting processor could queue the span, which is the ordering that
    // masking depends on.
    let kindSeenDownstream: unknown = "downstream delegate never ran";
    spanProcessorSink(client).add({
      onStart() {},
      onEnd(span) {
        kindSeenDownstream = span.attributes["openinference.span.kind"];
      },
      async forceFlush() {},
      async shutdown() {},
    });

    const span = getTracer().startSpan("ai.generateText.doGenerate", {
      attributes: VERCEL_SPAN_ATTRIBUTES,
    });
    span.end();

    expect(kindSeenDownstream).toBe("LLM");
    await client.shutdown();
  });
});
