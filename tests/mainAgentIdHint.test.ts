import { DiagLogLevel, type DiagLogger, diag } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InitOptions, RiusClient } from "../src/client.js";

const HINT = "mainAgentId";

// The hint is once per process, so each test loads a fresh copy of the module.
describe("derived main-agent id hint", () => {
  let client: RiusClient | undefined;
  let logger: { [K in keyof DiagLogger]: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.resetModules();
    logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
    diag.setLogger(logger, { logLevel: DiagLogLevel.DEBUG, suppressOverrideMessage: true });
  });

  afterEach(async () => {
    await client?.shutdown();
    client = undefined;
    diag.disable();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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

  function hints(level: keyof DiagLogger = "debug"): unknown[][] {
    return logger[level].mock.calls.filter((call) => String(call[0]).includes(HINT));
  }

  function allHints(): unknown[][] {
    return (Object.keys(logger) as (keyof DiagLogger)[]).flatMap((level) => hints(level));
  }

  it("logs one debug hint when the id is derived from the name", async () => {
    await initTwice({ agentName: "planner" });
    expect(hints("debug")).toHaveLength(1);
    expect(allHints()).toHaveLength(1);
  });

  it("logs no hint when an id is configured", async () => {
    await initTwice({ agentName: "planner", mainAgentId: "ag_prod_7" });
    expect(allHints()).toHaveLength(0);
  });

  it("logs no hint when the operator set the id", async () => {
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "gen_ai.main_agent.id=from-otel");
    await initTwice({ agentName: "planner" });
    expect(allHints()).toHaveLength(0);
  });

  it("logs no hint with no name and no id, when no entity is emitted", async () => {
    await initTwice({});
    expect(allHints()).toHaveLength(0);
  });

  it("prints nothing by default, when no diag logger is installed", async () => {
    diag.disable();
    const printed = (["debug", "log", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    await initTwice({ agentName: "planner" });
    for (const spy of printed) {
      expect(spy.mock.calls.filter((call) => String(call[0]).includes(HINT))).toHaveLength(0);
    }
  });
});
