import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { init, type RiusClient } from "../src/client.js";
import {
  hasAuthorization,
  resolveConfig,
  withoutAuthorization,
  workspaceHeaders,
} from "../src/config.js";
import { startSpan } from "../src/spans.js";
import { withWorkspace } from "../src/workspace.js";

// `init({ headers })`, with the Python SDK's semantics: the headers ride every
// request the SDK makes (spans and heartbeat), an explicit Authorization header
// wins over `apiKey` and counts as credentials, and a workspace destination
// sends its own key in place of the default Authorization.

describe("resolveConfig headers", () => {
  it("injects the API key as a bearer Authorization header", () => {
    expect(resolveConfig({ apiKey: "secret" }, {}).headers).toEqual({
      Authorization: "Bearer secret",
    });
  });

  it("keeps an explicit Authorization header over the API key", () => {
    const config = resolveConfig(
      { apiKey: "secret", headers: { Authorization: "Bearer custom" } },
      {},
    );
    expect(config.headers).toEqual({ Authorization: "Bearer custom" });
  });

  it("matches Authorization in any case, adding no second one", () => {
    const config = resolveConfig(
      { headers: { authorization: "Bearer custom" } },
      { RIUS_API_KEY: "env" },
    );
    expect(config.headers).toEqual({ authorization: "Bearer custom" });
  });

  it("keeps the other headers beside the injected key", () => {
    const config = resolveConfig({ apiKey: "k", headers: { "x-tenant": "t1" } }, {});
    expect(config.headers).toEqual({ "x-tenant": "t1", Authorization: "Bearer k" });
  });

  it("sends no Authorization without a key or an explicit header", () => {
    expect(resolveConfig({}, {}).headers).toEqual({});
    expect(resolveConfig({ apiKey: "" }, {}).headers).toEqual({});
  });

  it("copies the headers, so changing the caller's object later changes nothing", () => {
    const headers: Record<string, string> = { "x-tenant": "t1" };
    const config = resolveConfig({ headers }, {});
    headers["x-tenant"] = "t2";
    expect(config.headers).toEqual({ "x-tenant": "t1" });
  });

  it("warns about a header whose value is not a string and skips it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const headers = { "x-ok": "1", "x-bad": 2 } as unknown as Record<string, string>;
      expect(resolveConfig({ headers }, {}).headers).toEqual({ "x-ok": "1" });
      expect(warn.mock.calls.some((call) => String(call[0]).includes("x-bad"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns about headers that are not an object and ignores them", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const headers of ["Authorization: x", ["a"], null]) {
        const config = resolveConfig(
          { apiKey: "k", headers: headers as unknown as Record<string, string> },
          {},
        );
        expect(config.headers).toEqual({ Authorization: "Bearer k" });
      }
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it("takes a __proto__ header as a header, never as a prototype", () => {
    const headers = JSON.parse('{"__proto__": "x", "x-ok": "1"}') as Record<string, string>;
    const resolved = resolveConfig({ headers }, {}).headers;
    expect(Object.getPrototypeOf(resolved)).toBe(Object.prototype);
    expect(Object.hasOwn(resolved, "__proto__")).toBe(true);
    expect(resolved["x-ok"]).toBe("1");
  });
});

describe("resolveConfig folds header names case-insensitively", () => {
  it("keeps the last of two names that differ only in case, warning once without the values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const headers = { authorization: "Bearer secret-a", Authorization: "Bearer secret-b" };
      expect(resolveConfig({ apiKey: "k", headers }, {}).headers).toEqual({
        Authorization: "Bearer secret-b",
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message.toLowerCase()).toContain("authorization");
      expect(message).not.toContain("secret");
    } finally {
      warn.mockRestore();
    }
  });

  it("warns once however many names collide", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const headers = { "x-a": "1", "X-A": "2", "x-b": "1", "X-B": "2" };
      expect(resolveConfig({ headers }, {}).headers).toEqual({ "X-A": "2", "X-B": "2" });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("workspaceHeaders", () => {
  it("sends the workspace's key as the only Authorization, keeping the other headers", () => {
    const headers = workspaceHeaders(
      { authorization: "Bearer default", AUTHORIZATION: "Bearer other", "x-tenant": "t1" },
      "team-key",
    );
    expect(headers).toEqual({ "x-tenant": "t1", Authorization: "Bearer team-key" });
    const authorizations = Object.keys(headers).filter(
      (name) => name.toLowerCase() === "authorization",
    );
    expect(authorizations).toEqual(["Authorization"]);
  });
});

describe("Authorization helpers", () => {
  it("finds an Authorization header in any case", () => {
    expect(hasAuthorization({ AUTHORIZATION: "x" })).toBe(true);
    expect(hasAuthorization({ "x-authorization": "x" })).toBe(false);
  });

  it("drops every Authorization header, whatever its case, and keeps the rest", () => {
    expect(
      withoutAuthorization({
        authorization: "a",
        AUTHORIZATION: "b",
        Authorization: "c",
        "x-tenant": "t1",
      }),
    ).toEqual({ "x-tenant": "t1" });
  });
});

/** What a local OTLP endpoint received: the path and headers of every request. */
interface Received {
  path: string;
  headers: http.IncomingHttpHeaders;
  /** Every Authorization header as sent, so a duplicate shows up. */
  authorizations: string[];
  /** Every Content-Type header as sent. */
  contentTypes: string[];
}

describe("headers on the wire", () => {
  let client: RiusClient | undefined;
  let server: http.Server | undefined;

  afterEach(async () => {
    await client?.shutdown();
    client = undefined;
    const closing = server;
    server = undefined;
    if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
  });

  async function endpoint(): Promise<{ url: string; received: Received[] }> {
    const received: Received[] = [];
    server = http.createServer((request, response) => {
      const raw = request.rawHeaders;
      const values = (name: string) =>
        raw.filter((_, index) => index % 2 === 1 && raw[index - 1]?.toLowerCase() === name);
      received.push({
        path: request.url ?? "",
        headers: request.headers,
        authorizations: values("authorization"),
        contentTypes: values("content-type"),
      });
      request.resume();
      request.on("end", () => response.writeHead(200).end());
    });
    const listening = server;
    await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
    const { port } = listening.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, received };
  }

  it("sends the headers with the spans, an explicit Authorization winning over the key", async () => {
    const { url, received } = await endpoint();
    client = init({
      endpoint: url,
      apiKey: "k",
      headers: { Authorization: "Bearer custom", "x-tenant": "t1" },
      heartbeat: false,
    });
    startSpan("op").end();
    await client.flush();
    const traces = received.filter((r) => r.path === "/v1/traces");
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0]?.headers.authorization).toBe("Bearer custom");
    expect(traces[0]?.headers["x-tenant"]).toBe("t1");
  });

  it("sends the headers with the heartbeat", async () => {
    const { url, received } = await endpoint();
    client = init({ endpoint: url, apiKey: "k", headers: { "x-tenant": "t1" }, heartbeat: true });
    await client.shutdown();
    client = undefined;
    const pings = received.filter((r) => r.path === "/v1/heartbeat");
    expect(pings.length).toBeGreaterThan(0);
    expect(pings[0]?.headers.authorization).toBe("Bearer k");
    expect(pings[0]?.headers["x-tenant"]).toBe("t1");
  });

  it("sends one Authorization and its own JSON content type with the heartbeat", async () => {
    const { url, received } = await endpoint();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      client = init({
        endpoint: url,
        headers: {
          authorization: "Bearer a",
          Authorization: "Bearer b",
          "Content-Type": "text/plain",
        },
        heartbeat: true,
      });
      startSpan("op").end();
      await client.flush();
      await client.shutdown();
      client = undefined;
    } finally {
      warn.mockRestore();
    }
    const pings = received.filter((r) => r.path === "/v1/heartbeat");
    expect(pings.length).toBeGreaterThan(0);
    for (const ping of pings) {
      expect(ping.authorizations).toEqual(["Bearer b"]);
      expect(ping.contentTypes).toEqual(["application/json"]);
    }
    const traces = received.filter((r) => r.path === "/v1/traces");
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0]?.authorizations).toEqual(["Bearer b"]);
  });

  it("starts the heartbeat on an explicit Authorization header alone", async () => {
    const { url, received } = await endpoint();
    vi.stubEnv("RIUS_API_KEY", undefined);
    try {
      client = init({
        endpoint: url,
        headers: { authorization: "Bearer custom" },
        heartbeat: true,
      });
      await client.shutdown();
      client = undefined;
    } finally {
      vi.unstubAllEnvs();
    }
    const pings = received.filter((r) => r.path === "/v1/heartbeat");
    expect(pings.length).toBeGreaterThan(0);
    expect(pings[0]?.headers.authorization).toBe("Bearer custom");
  });

  it("sends a workspace's spans with its own key in place of the default Authorization", async () => {
    const { url, received } = await endpoint();
    client = init({
      endpoint: url,
      headers: { authorization: "Bearer default", "x-tenant": "t1" },
      workspaces: { team: "team-key" },
      heartbeat: false,
    });
    withWorkspace("team", () => startSpan("routed").end());
    await client.flush();
    const traces = received.filter((r) => r.path === "/v1/traces");
    expect(traces).toHaveLength(1);
    expect(traces[0]?.authorizations).toEqual(["Bearer team-key"]);
    expect(traces[0]?.headers["x-tenant"]).toBe("t1");
  });
});
