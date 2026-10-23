import type { TracerProvider } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type InitOptions, init, type RiusClient } from "../src/client.js";
import { enableInstrumentations, REGISTRY, type RegistryEntry } from "../src/instrumentation.js";

// `init({ instruments })` picks the bundled integrations by name, as the Python
// SDK's `init(instruments=[...])` does: omitted enables every one it finds, a
// list restricts to those names, `[]` enables none, and an unknown name warns
// and is skipped.

let live: RiusClient | undefined;

function initTracked(options: InitOptions = {}): RiusClient {
  live = init({ spanExporter: new InMemorySpanExporter(), heartbeat: false, ...options });
  return live;
}

afterEach(async () => {
  const client = live;
  live = undefined;
  await client?.shutdown().catch(() => {});
});

/** Runs `body` with the registry holding exactly `entries`, then restores it. */
async function withRegistry(entries: RegistryEntry[], body: () => Promise<void>): Promise<void> {
  const saved = REGISTRY.splice(0, REGISTRY.length, ...entries);
  try {
    await body();
  } finally {
    REGISTRY.splice(0, REGISTRY.length, ...saved);
  }
}

/** A self-applying entry that records its loads and the undoing of each. */
function recordingEntry(name: string, log: string[]): RegistryEntry {
  return {
    name,
    kind: "self-applying",
    async load(_provider, teardown) {
      log.push(`load ${name}`);
      teardown?.push(() => log.push(`undo ${name}`));
      return true;
    },
  };
}

function spyOnWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

function warnings(warn: ReturnType<typeof spyOnWarn>): string[] {
  return warn.mock.calls.map((call) => String(call[0]));
}

describe("init({ instruments })", () => {
  it("enables every integration it finds when the option is omitted", async () => {
    const log: string[] = [];
    await withRegistry([recordingEntry("alpha", log), recordingEntry("beta", log)], async () => {
      expect(await initTracked().ready).toEqual(["alpha", "beta"]);
    });
  });

  it("enables only the integrations it names", async () => {
    const log: string[] = [];
    await withRegistry([recordingEntry("alpha", log), recordingEntry("beta", log)], async () => {
      expect(await initTracked({ instruments: ["beta"] }).ready).toEqual(["beta"]);
      // The other one is never loaded, so it patches nothing.
      expect(log).toEqual(["load beta"]);
    });
  });

  it("enables none with an empty list", async () => {
    const log: string[] = [];
    await withRegistry([recordingEntry("alpha", log)], async () => {
      expect(await initTracked({ instruments: [] }).ready).toEqual([]);
      expect(log).toEqual([]);
    });
  });

  it("warns about an unknown name, listing the known ones, and enables the rest", async () => {
    const log: string[] = [];
    await withRegistry([recordingEntry("alpha", log), recordingEntry("beta", log)], async () => {
      const warn = spyOnWarn();
      try {
        expect(await initTracked({ instruments: ["not-a-thing", "alpha"] }).ready).toEqual([
          "alpha",
        ]);
        const unknown = warnings(warn).filter((message) => message.includes("not-a-thing"));
        expect(unknown).toHaveLength(1);
        expect(unknown[0]).toContain("alpha, beta");
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("warns about a name that is not a string and skips it", async () => {
    const log: string[] = [];
    await withRegistry([recordingEntry("alpha", log)], async () => {
      const warn = spyOnWarn();
      try {
        const instruments = [42, "alpha"] as unknown as string[];
        expect(await initTracked({ instruments }).ready).toEqual(["alpha"]);
        expect(warnings(warn).some((message) => message.includes("42"))).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("warns and keeps the default set when the option is not a list", async () => {
    const log: string[] = [];
    await withRegistry([recordingEntry("alpha", log), recordingEntry("beta", log)], async () => {
      const warn = spyOnWarn();
      try {
        const instruments = "alpha" as unknown as string[];
        expect(await initTracked({ instruments }).ready).toEqual(["alpha", "beta"]);
        expect(warnings(warn).some((message) => message.includes("instruments"))).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("warns when a named integration's packages are not installed, saying what to install", async () => {
    const absent: RegistryEntry = {
      name: "absent",
      kind: "instrumentation",
      install: "install some-instrumentation-package",
      load: async () => undefined,
    };
    await withRegistry([absent], async () => {
      const warn = spyOnWarn();
      try {
        expect(await initTracked({ instruments: ["absent"] }).ready).toEqual([]);
        const messages = warnings(warn);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('"absent"');
        expect(messages[0]).toContain("install some-instrumentation-package");
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("stays quiet about a missing integration nobody named", async () => {
    const absent: RegistryEntry = {
      name: "absent",
      kind: "instrumentation",
      load: async () => undefined,
    };
    await withRegistry([absent], async () => {
      const warn = spyOnWarn();
      try {
        expect(await initTracked().ready).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("warns once, not twice, when a named integration is installed but broken", async () => {
    const broken: RegistryEntry = {
      name: "broken",
      kind: "instrumentation",
      install: "install it",
      load: () => Promise.reject(new Error("prototype is not writable")),
    };
    await withRegistry([broken], async () => {
      const warn = spyOnWarn();
      try {
        expect(await initTracked({ instruments: ["broken"] }).ready).toEqual([]);
        expect(warnings(warn)).toHaveLength(1);
        expect(warnings(warn)[0]).toContain("prototype is not writable");
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("names the bundled integrations as the Python SDK does where both have one", () => {
    const names = REGISTRY.map((entry) => entry.name);
    for (const shared of ["openai", "anthropic", "langchain", "mcp"]) {
      expect(names).toContain(shared);
    }
  });

  it("says what to install for every bundled integration", () => {
    for (const entry of REGISTRY) expect(entry.install, entry.name).toBeTruthy();
  });
});

describe("which client holds an integration", () => {
  const globalProvider = { getTracer: () => undefined } as unknown as TracerProvider;
  const scopedProvider = { getTracer: () => undefined } as unknown as TracerProvider;

  /** Runs every function in `teardown`, as shutdown() does. */
  function release(teardown: Array<() => void>): void {
    for (const undo of teardown.splice(0)) undo();
  }

  it("leaves an integration a live global client holds where it is, with a warning", async () => {
    const log: string[] = [];
    await withRegistry([recordingEntry("alpha", log)], async () => {
      const held: Array<() => void> = [];
      const scoped: Array<() => void> = [];
      expect(await enableInstrumentations(globalProvider, undefined, held)).toEqual(["alpha"]);
      const warn = spyOnWarn();
      try {
        expect(
          await enableInstrumentations(scopedProvider, ["alpha"], scoped, { forGlobal: false }),
        ).toEqual([]);
        const messages = warnings(warn);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('"alpha"');
        expect(messages[0]).toContain("global");
      } finally {
        warn.mockRestore();
      }
      // The global client's patch was neither undone nor applied a second time.
      expect(log).toEqual(["load alpha"]);
      release(scoped);
      expect(log).toEqual(["load alpha"]);
      release(held);
    });
  });

  it("lets a scoped client take an integration once the global client released it", async () => {
    const log: string[] = [];
    await withRegistry([recordingEntry("alpha", log)], async () => {
      const held: Array<() => void> = [];
      const scoped: Array<() => void> = [];
      await enableInstrumentations(globalProvider, undefined, held);
      release(held);
      expect(
        await enableInstrumentations(scopedProvider, ["alpha"], scoped, { forGlobal: false }),
      ).toEqual(["alpha"]);
      expect(log).toEqual(["load alpha", "undo alpha", "load alpha"]);
      release(scoped);
    });
  });

  it("moves an integration a scoped client holds to a global client", async () => {
    const log: string[] = [];
    await withRegistry([recordingEntry("alpha", log)], async () => {
      const scoped: Array<() => void> = [];
      const held: Array<() => void> = [];
      await enableInstrumentations(scopedProvider, ["alpha"], scoped, { forGlobal: false });
      expect(await enableInstrumentations(globalProvider, undefined, held)).toEqual(["alpha"]);
      // Undone for the scoped client first, so the patch is applied afresh.
      expect(log).toEqual(["load alpha", "undo alpha", "load alpha"]);
      // The scoped client shutting down later leaves the global one's patch alone.
      release(scoped);
      expect(log).toEqual(["load alpha", "undo alpha", "load alpha"]);
      release(held);
      expect(log).toEqual(["load alpha", "undo alpha", "load alpha", "undo alpha"]);
    });
  });

  it("undoes what onEnabled added when the integration moves to another client", async () => {
    const log: string[] = [];
    await withRegistry([recordingEntry("alpha", log)], async () => {
      const scoped: Array<() => void> = [];
      const held: Array<() => void> = [];
      await enableInstrumentations(scopedProvider, ["alpha"], scoped, {
        forGlobal: false,
        onEnabled: (name, undo) => undo.push(() => log.push(`stop ${name} extras`)),
      });
      await enableInstrumentations(globalProvider, undefined, held);
      expect(log).toEqual(["load alpha", "undo alpha", "stop alpha extras", "load alpha"]);
      release(held);
    });
  });
});
