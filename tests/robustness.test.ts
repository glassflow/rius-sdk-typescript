import { ROOT_CONTEXT, context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { resolveConfig } from "../src/config.js";
import { HeartbeatSender, type OpenRootSpanTracker } from "../src/heartbeat.js";
import { SESSION_ID, WORKSPACE_ROUTE } from "../src/semconv.js";
import { toAttributeValue } from "../src/serde.js";
import { withSession } from "../src/session.js";
import { startAsCurrentSpan, startSpan } from "../src/spans.js";
import { withWorkspace } from "../src/workspace.js";

/** Edge cases from the 2026-09-14 review that crashed, spun or silently dropped. */

let client: RiusClient | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await client?.shutdown();
  client = undefined;
});

describe("serde robustness", () => {
  it("renders BigInt as a string instead of dropping the whole payload", () => {
    expect(toAttributeValue({ id: 1n, text: "hello" })).toBe('{"id":"1","text":"hello"}');
  });

  it("renders Map as an object and Set as an array", () => {
    expect(toAttributeValue({ m: new Map([["k", "v"]]), s: new Set([1, 2]) })).toBe(
      '{"m":{"k":"v"},"s":[1,2]}',
    );
  });

  it("summarises binary payloads instead of exploding them into byte arrays", () => {
    expect(toAttributeValue({ b: Buffer.alloc(8) })).toBe('{"b":"<Buffer 8 bytes>"}');
    expect(toAttributeValue({ u: new Uint8Array(3) })).toBe('{"u":"<Uint8Array 3 bytes>"}');
  });
});

describe("config clamps", () => {
  it("treats NaN as unset for the interval and the delay", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = resolveConfig(
      { heartbeatInterval: Number.NaN, partialSpansDelay: Number.NaN },
      {},
    );
    expect(config.heartbeatIntervalMs).toBe(resolveConfig({}, {}).heartbeatIntervalMs);
    expect(config.partialSpansDelayMs).toBe(resolveConfig({}, {}).partialSpansDelayMs);
    expect(warn).toHaveBeenCalled();
  });
});

describe("HeartbeatSender.start()", () => {
  it("is idempotent: a second start() does not leak a timer past stop()", async () => {
    vi.useFakeTimers();
    let pings = 0;
    const sender = new HeartbeatSender({
      url: "http://example.invalid/v1/heartbeat",
      headers: {},
      intervalMs: 1000,
      agentName: "a",
      instanceId: "i",
      tracker: { openTraceIds: () => [] } as unknown as OpenRootSpanTracker,
      transport: async () => {
        pings += 1;
      },
    });
    sender.start();
    sender.start();
    await vi.advanceTimersByTimeAsync(2500);
    await sender.stop();
    const afterStop = pings;
    await vi.advanceTimersByTimeAsync(5000);
    expect(pings).toBe(afterStop);
  });
});

describe("context stamps follow an explicitly re-parented child", () => {
  it("routes a child parented to an in-scope span even when the context lost the alias", async () => {
    const defaultExporter = new InMemorySpanExporter();
    const perKey: Record<string, InMemorySpanExporter> = {};
    client = init({
      spanExporter: defaultExporter,
      workspaces: { acme: "key-acme" },
      workspaceExporterFactory: (apiKey) => {
        perKey[apiKey] = new InMemorySpanExporter();
        return perKey[apiKey];
      },
      heartbeatTransport: async () => {},
    });
    await withWorkspace("acme", async () => {
      await startAsCurrentSpan("root", async (root) => {
        // An EventEmitter/stream callback that lost ALS context and re-parents by hand.
        await context.with(trace.setSpan(ROOT_CONTEXT, root.span), async () => {
          startSpan("child").end();
        });
      });
    });
    await client.flush();
    const routed = perKey["key-acme"]
      .getFinishedSpans()
      .map((s) => s.name)
      .sort();
    expect(routed).toEqual(["child", "root"]);
    expect(defaultExporter.getFinishedSpans()).toHaveLength(0);
  });

  it("inherits the session from a re-parented child's parent span", async () => {
    const exporter = new InMemorySpanExporter();
    client = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
    await withSession("sess-1", async () => {
      await startAsCurrentSpan("root", async (root) => {
        await context.with(trace.setSpan(ROOT_CONTEXT, root.span), async () => {
          startSpan("child").end();
        });
      });
    });
    await client.flush();
    const child = exporter.getFinishedSpans().find((s) => s.name === "child");
    expect(child?.attributes[SESSION_ID]).toBe("sess-1");
  });

  it("warns once per straddle, not once per span", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    client = init({
      spanExporter: new InMemorySpanExporter(),
      workspaces: { a: "ka", b: "kb" },
      workspaceExporterFactory: () => new InMemorySpanExporter(),
      heartbeatTransport: async () => {},
    });
    await withWorkspace("a", async () => {
      await startAsCurrentSpan("root", async () => {
        await withWorkspace("b", async () => {
          for (let i = 0; i < 50; i++) startSpan(`child-${i}`).end();
        });
      });
    });
    const straddles = warn.mock.calls.filter((c) => String(c[0]).includes("straddle"));
    expect(straddles).toHaveLength(1);
    void WORKSPACE_ROUTE;
  });
});
