import { ExportResultCode } from "@opentelemetry/core";
/**
 * Workspaces: context-scoped routing of spans to per-customer destinations.
 *
 * Wire contract under test: spans started inside `withWorkspace(alias, fn)`
 * are delivered by the exporter registered for that alias, spans outside any
 * scope go to the default exporter, and the transient routing attribute is
 * stripped before spans leave the process (the destination's API key already
 * says which workspace a span belongs to).
 */
import {
  InMemorySpanExporter,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import {
  GLASSFLOW_SPAN_PENDING,
  PENDING_IDENTITY_ATTRIBUTES,
  WORKSPACE_ROUTE,
} from "../src/semconv.js";
import { startAsCurrentSpan, startSpan } from "../src/spans.js";
import { registerWorkspace, withWorkspace } from "../src/workspace.js";

let client: RiusClient;
let defaultExporter: InMemorySpanExporter;
let perKey: Record<string, InMemorySpanExporter>;

function routedInit(options: Parameters<typeof init>[0] = {}): RiusClient {
  defaultExporter = new InMemorySpanExporter();
  perKey = {};
  client = init({
    spanExporter: defaultExporter,
    workspaces: { acme: "key-acme", globex: "key-globex" },
    workspaceExporterFactory: (apiKey: string) => {
      perKey[apiKey] = new InMemorySpanExporter();
      return perKey[apiKey];
    },
    heartbeatTransport: async () => {},
    serviceName: "test-svc",
    ...options,
  });
  return client;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await client.shutdown();
});

describe("withWorkspace", () => {
  it("routes every span in the scope, children included", async () => {
    routedInit();
    await withWorkspace("acme", async () => {
      await startAsCurrentSpan("root", {}, async () => {
        startSpan("child").end();
      });
    });
    await client.flush();
    expect(defaultExporter.getFinishedSpans()).toHaveLength(0);
    const spans = perKey["key-acme"].getFinishedSpans();
    expect(spans.map((s) => s.name).sort()).toEqual(["child", "root"]);
  });

  it("routes spans outside a scope to the default destination", async () => {
    routedInit();
    startSpan("bare").end();
    await client.flush();
    expect(defaultExporter.getFinishedSpans().map((s) => s.name)).toEqual(["bare"]);
    expect(perKey["key-acme"]?.getFinishedSpans() ?? []).toHaveLength(0);
  });

  it("partitions one batch across scopes and default", async () => {
    routedInit();
    await withWorkspace("acme", async () => {
      startSpan("for-acme").end();
    });
    await withWorkspace("globex", async () => {
      startSpan("for-globex").end();
    });
    startSpan("for-default").end();
    await client.flush();
    expect(perKey["key-acme"].getFinishedSpans().map((s) => s.name)).toEqual(["for-acme"]);
    expect(perKey["key-globex"].getFinishedSpans().map((s) => s.name)).toEqual(["for-globex"]);
    expect(defaultExporter.getFinishedSpans().map((s) => s.name)).toEqual(["for-default"]);
  });

  it("never lets the routing attribute reach the wire", async () => {
    routedInit();
    await withWorkspace("acme", async () => {
      startSpan("routed").end();
    });
    startSpan("bare").end();
    await client.flush();
    for (const exporter of [defaultExporter, perKey["key-acme"]]) {
      for (const span of exporter.getFinishedSpans()) {
        expect(span.attributes[WORKSPACE_ROUTE]).toBeUndefined();
      }
    }
  });

  it("ends the scope with the callback", async () => {
    routedInit();
    await withWorkspace("acme", async () => {
      startSpan("inside").end();
    });
    startSpan("after").end();
    await client.flush();
    expect(perKey["key-acme"].getFinishedSpans().map((s) => s.name)).toEqual(["inside"]);
    expect(defaultExporter.getFinishedSpans().map((s) => s.name)).toEqual(["after"]);
  });

  it("falls back to the default destination for an unknown alias, with a warning", async () => {
    routedInit();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await withWorkspace("no-such-customer", async () => {
      startSpan("lost").end();
    });
    await client.flush();
    expect(defaultExporter.getFinishedSpans().map((s) => s.name)).toEqual(["lost"]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("no-such-customer"))).toBe(true);
  });

  it("warns when a trace straddles two workspaces", async () => {
    routedInit();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await withWorkspace("acme", async () => {
      await startAsCurrentSpan("root", {}, async () => {
        await withWorkspace("globex", async () => {
          startSpan("child").end();
        });
      });
    });
    await client.flush();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("workspace"))).toBe(true);
  });
});

describe("registerWorkspace", () => {
  it("adds a destination after init", async () => {
    routedInit();
    registerWorkspace("initech", "key-initech");
    await withWorkspace("initech", async () => {
      startSpan("late").end();
    });
    await client.flush();
    expect(perKey["key-initech"].getFinishedSpans().map((s) => s.name)).toEqual(["late"]);
  });

  it("throws when routing was not enabled at init", async () => {
    defaultExporter = new InMemorySpanExporter();
    client = init({
      spanExporter: defaultExporter,
      heartbeatTransport: async () => {},
      serviceName: "test-svc",
    });
    expect(() => registerWorkspace("acme", "key-acme")).toThrow(/workspaces/);
  });

  it("an empty workspaces map opts into pure-dynamic routing", async () => {
    defaultExporter = new InMemorySpanExporter();
    perKey = {};
    client = init({
      spanExporter: defaultExporter,
      workspaces: {},
      workspaceExporterFactory: (apiKey: string) => {
        perKey[apiKey] = new InMemorySpanExporter();
        return perKey[apiKey];
      },
      heartbeatTransport: async () => {},
      serviceName: "test-svc",
    });
    registerWorkspace("acme", "key-acme");
    await withWorkspace("acme", async () => {
      startSpan("routed").end();
    });
    await client.flush();
    expect(perKey["key-acme"].getFinishedSpans().map((s) => s.name)).toEqual(["routed"]);
  });
});

describe("lifecycle", () => {
  it("shutdown reaches every destination exporter", async () => {
    const shut: string[] = [];
    defaultExporter = new InMemorySpanExporter();
    const recording = (name: string): SpanExporter => ({
      export: (spans: ReadableSpan[], cb) => cb({ code: ExportResultCode.SUCCESS }),
      forceFlush: async () => {},
      shutdown: async () => {
        shut.push(name);
      },
    });
    perKey = {};
    client = init({
      spanExporter: defaultExporter,
      workspaces: { acme: "key-acme" },
      workspaceExporterFactory: (apiKey: string) => recording(apiKey),
      heartbeatTransport: async () => {},
      serviceName: "test-svc",
    });
    await withWorkspace("acme", async () => {
      startSpan("s").end();
    });
    await client.flush();
    await client.shutdown();
    expect(shut).toContain("key-acme");
    // afterEach shuts down again; make it a no-op second call.
  });
});

describe("pending snapshots", () => {
  it("route with the scope and arrive stripped", async () => {
    expect(PENDING_IDENTITY_ATTRIBUTES.has(WORKSPACE_ROUTE)).toBe(true);
    routedInit({ partialSpans: true });
    await withWorkspace("acme", async () => {
      await startAsCurrentSpan("long-run", {}, async () => {
        await client.flush();
        const pending = perKey["key-acme"].getFinishedSpans();
        expect(pending).toHaveLength(1);
        expect(pending[0].attributes[GLASSFLOW_SPAN_PENDING]).toBe(true);
        expect(pending[0].attributes[WORKSPACE_ROUTE]).toBeUndefined();
      });
    });
    await client.flush();
  });
});
