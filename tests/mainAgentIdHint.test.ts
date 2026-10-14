import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InitOptions, RiusClient } from "../src/client.js";

// The hint is once per process, so each test loads a fresh copy of the module.
describe("derived main-agent id hint", () => {
  let client: RiusClient | undefined;
  let debug: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(async () => {
    await client?.shutdown();
    client = undefined;
    debug.mockRestore();
  });

  async function initTwice(options: InitOptions): Promise<void> {
    const { init } = await import("../src/client.js");
    for (let i = 0; i < 2; i++) {
      await client?.shutdown();
      client = init({
        spanExporter: new InMemorySpanExporter(),
        heartbeatTransport: async () => {},
        ...options,
      });
    }
  }

  function hints(): unknown[][] {
    return debug.mock.calls.filter((call) => String(call[0]).includes("mainAgentId"));
  }

  it("logs one debug hint when the id is derived from the name", async () => {
    await initTwice({ agentName: "planner" });
    expect(hints()).toHaveLength(1);
  });

  it("logs no hint when an id is configured", async () => {
    await initTwice({ agentName: "planner", mainAgentId: "ag_prod_7" });
    expect(hints()).toHaveLength(0);
  });
});
