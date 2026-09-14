import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { startAsCurrentGeneration, startGeneration } from "../src/generation.js";
import {
  GLASSFLOW_SPAN_PENDING,
  PENDING_IDENTITY_ATTRIBUTES,
  SESSION_ID,
  USER_ID,
} from "../src/semconv.js";
import { withSession } from "../src/session.js";
import { startAsCurrentSpan, startSpan } from "../src/spans.js";
import { withUser } from "../src/user.js";

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

describe("withUser", () => {
  it("stamps every span in the scope, children included", async () => {
    testInit();
    await withUser("u-1", async () => {
      await startAsCurrentSpan("root", {}, async () => {
        startSpan("child").end();
      });
    });
    await client.flush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    for (const span of spans) expect(span.attributes[USER_ID]).toBe("u-1");
  });

  it("sets nothing outside a scope", async () => {
    testInit();
    startSpan("bare").end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes[USER_ID]).toBeUndefined();
  });

  it("ends with the callback", async () => {
    testInit();
    await withUser("u-1", async () => {
      startSpan("inside").end();
    });
    startSpan("after").end();
    await client.flush();
    const byName = new Map(exporter.getFinishedSpans().map((s) => [s.name, s]));
    expect(byName.get("inside")?.attributes[USER_ID]).toBe("u-1");
    expect(byName.get("after")?.attributes[USER_ID]).toBeUndefined();
  });

  it("keeps sibling scopes apart", async () => {
    testInit();
    await withUser("alice", async () => {
      startSpan("a").end();
    });
    await withUser("bob", async () => {
      startSpan("b").end();
    });
    await client.flush();
    const byName = new Map(exporter.getFinishedSpans().map((s) => [s.name, s]));
    expect(byName.get("a")?.attributes[USER_ID]).toBe("alice");
    expect(byName.get("b")?.attributes[USER_ID]).toBe("bob");
  });

  it("lets the inner scope win when nested", async () => {
    testInit();
    await withUser("outer", async () =>
      withUser("inner", async () => {
        startSpan("s").end();
      }),
    );
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes[USER_ID]).toBe("inner");
  });

  it("is independent of the session scope", async () => {
    testInit();
    await withUser("u-1", async () =>
      withSession("sess-1", async () => {
        startSpan("s").end();
      }),
    );
    await client.flush();
    const attrs = exporter.getFinishedSpans()[0].attributes;
    expect(attrs[USER_ID]).toBe("u-1");
    expect(attrs[SESSION_ID]).toBe("sess-1");
  });

  it("passes the id to the callback and returns the callback's value", async () => {
    testInit();
    let seen: string | undefined;
    const result = await withUser("u-1", async (userId) => {
      seen = userId;
      return 42;
    });
    expect(seen).toBe("u-1");
    expect(result).toBe(42);
  });
});

describe("no process-wide default, by design", () => {
  it("ignores RIUS_USER_ID", async () => {
    vi.stubEnv("RIUS_USER_ID", "from-env");
    try {
      testInit();
      startSpan("s").end();
      await client.flush();
      expect(exporter.getFinishedSpans()[0].attributes[USER_ID]).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("pending spans", () => {
  it("carries the user id on the pending snapshot", async () => {
    expect(PENDING_IDENTITY_ATTRIBUTES.has(USER_ID)).toBe(true);
    testInit({ partialSpans: true });
    await withUser("u-p", async () => {
      await startAsCurrentSpan("op", {}, async () => {
        await client.flush(); // snapshot exported while the span is open
      });
    });
    await client.flush();
    const pending = exporter.getFinishedSpans().filter((s) => s.attributes[GLASSFLOW_SPAN_PENDING]);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0].attributes[USER_ID]).toBe("u-p");
  });
});

describe("userId option sugar", () => {
  it("stamps the span from startSpan", async () => {
    testInit();
    startSpan("manual", { userId: "u-m" }).end();
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes[USER_ID]).toBe("u-m");
  });

  it("scopes children from startAsCurrentSpan", async () => {
    testInit();
    await startAsCurrentSpan("root", { userId: "u-s" }, async () => {
      startSpan("child").end();
    });
    await client.flush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    for (const span of spans) expect(span.attributes[USER_ID]).toBe("u-s");
  });

  it("stamps generations from both entry points", async () => {
    testInit();
    startGeneration("gen", { model: "m", userId: "u-g" }).end();
    await startAsCurrentGeneration("gen2", { model: "m", userId: "u-g2" }, async () => {
      startSpan("child").end();
    });
    await client.flush();
    const byName = new Map(exporter.getFinishedSpans().map((s) => [s.name, s]));
    expect(byName.get("gen")?.attributes[USER_ID]).toBe("u-g");
    expect(byName.get("gen2")?.attributes[USER_ID]).toBe("u-g2");
    expect(byName.get("child")?.attributes[USER_ID]).toBe("u-g2");
  });

  it("does not leak past the call", async () => {
    testInit();
    await startAsCurrentSpan("with-user", { userId: "u-x" }, async () => {});
    startSpan("after").end();
    await client.flush();
    const byName = new Map(exporter.getFinishedSpans().map((s) => [s.name, s]));
    expect(byName.get("after")?.attributes[USER_ID]).toBeUndefined();
  });
});
