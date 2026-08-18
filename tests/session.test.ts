import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { GLASSFLOW_SPAN_PENDING, PENDING_IDENTITY_ATTRIBUTES, SESSION_ID } from "../src/semconv.js";
import { withSession } from "../src/session.js";
import { startAsCurrentSpan, startSpan } from "../src/spans.js";

let client: RiusClient;
let exporter: InMemorySpanExporter;

function testInit(options: Parameters<typeof init>[0] = {}): RiusClient {
  exporter = new InMemorySpanExporter();
  client = init({
    spanExporter: exporter,
    heartbeatTransport: async () => {},
    serviceName: "test-svc",
    ...options,
  });
  return client;
}

afterEach(async () => {
  await client.shutdown();
});

describe("withSession", () => {
  it("stamps every span in the scope, children included", async () => {
    testInit();
    await withSession("sess-1", async () => {
      await startAsCurrentSpan("root", {}, async () => {
        startSpan("child").end();
      });
    });
    await client.flush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    for (const span of spans) expect(span.attributes[SESSION_ID]).toBe("sess-1");
  });

  it("sets nothing outside a scope", async () => {
    testInit();
    startSpan("bare").end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes[SESSION_ID]).toBeUndefined();
  });

  it("ends with the callback", async () => {
    testInit();
    await withSession("sess-1", async () => {
      startSpan("inside").end();
    });
    startSpan("after").end();
    await client.flush();
    const byName = new Map(exporter.getFinishedSpans().map((s) => [s.name, s]));
    expect(byName.get("inside")?.attributes[SESSION_ID]).toBe("sess-1");
    expect(byName.get("after")?.attributes[SESSION_ID]).toBeUndefined();
  });

  it("lets the inner scope win when nested", async () => {
    testInit();
    await withSession("outer", async () =>
      withSession("inner", async () => {
        startSpan("s").end();
      }),
    );
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes[SESSION_ID]).toBe("inner");
  });

  it("mints a UUID when called without an id, and passes it to the callback", async () => {
    testInit();
    let seen: string | undefined;
    await withSession(async (sessionId) => {
      seen = sessionId;
      startSpan("s").end();
    });
    await client.flush();
    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
    expect(exporter.getFinishedSpans()[0].attributes[SESSION_ID]).toBe(seen);
  });

  it("returns the callback's value", async () => {
    testInit();
    const result = await withSession("sess-1", async () => 42);
    expect(result).toBe(42);
  });
});

describe("the init-level default", () => {
  it("applies when no scope is active", async () => {
    testInit({ sessionId: "proc-wide" });
    startSpan("s").end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes[SESSION_ID]).toBe("proc-wide");
  });

  it("is overridden by an active scope", async () => {
    testInit({ sessionId: "proc-wide" });
    await withSession("per-turn", async () => {
      startSpan("s").end();
    });
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes[SESSION_ID]).toBe("per-turn");
  });

  it("reads RIUS_SESSION_ID", async () => {
    vi.stubEnv("RIUS_SESSION_ID", "from-env");
    try {
      testInit();
      startSpan("s").end();
      await client.flush();
      expect(exporter.getFinishedSpans()[0].attributes[SESSION_ID]).toBe("from-env");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("pending spans", () => {
  it("carries the session id on the pending snapshot", async () => {
    expect(PENDING_IDENTITY_ATTRIBUTES.has(SESSION_ID)).toBe(true);
    testInit({ partialSpans: true });
    await withSession("sess-p", async () => {
      await startAsCurrentSpan("op", {}, async () => {
        await client.flush(); // snapshot exported while the span is open
      });
    });
    await client.flush();
    const pending = exporter.getFinishedSpans().filter((s) => s.attributes[GLASSFLOW_SPAN_PENDING]);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0].attributes[SESSION_ID]).toBe("sess-p");
  });
});
