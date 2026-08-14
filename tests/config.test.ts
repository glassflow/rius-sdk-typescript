import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ENDPOINT, resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("defaults with an empty environment", () => {
    const c = resolveConfig({}, {});
    expect(c.endpoint).toBe(DEFAULT_ENDPOINT);
    expect(c.serviceName).toBe("unknown_service");
    expect(c.captureContent).toBe(true);
    expect(c.disabled).toBe(false);
    expect(c.sampleRate).toBe(1.0);
    expect(c.apiKey).toBeUndefined();
  });

  it("reads RIUS_ environment variables", () => {
    const c = resolveConfig(
      {},
      {
        RIUS_ENDPOINT: "https://example.test",
        RIUS_API_KEY: "k",
        RIUS_SERVICE_NAME: "svc",
        RIUS_DISABLED: "true",
        RIUS_SAMPLE_RATE: "0.25",
        RIUS_CAPTURE_CONTENT: "false",
      },
    );
    expect(c).toMatchObject({
      endpoint: "https://example.test",
      apiKey: "k",
      serviceName: "svc",
      disabled: true,
      sampleRate: 0.25,
      captureContent: false,
    });
  });

  it("prefers explicit options over the environment", () => {
    const c = resolveConfig({ serviceName: "explicit" }, { RIUS_SERVICE_NAME: "from-env" });
    expect(c.serviceName).toBe("explicit");
  });

  it("ignores GLASSFLOW_ variables entirely", () => {
    const c = resolveConfig({}, { GLASSFLOW_API_KEY: "legacy", GLASSFLOW_SERVICE_NAME: "legacy" });
    expect(c.apiKey).toBeUndefined();
    expect(c.serviceName).toBe("unknown_service");
  });

  it("clamps an out-of-range sample rate and ignores unparseable ones", () => {
    expect(resolveConfig({}, { RIUS_SAMPLE_RATE: "5" }).sampleRate).toBe(1.0);
    expect(resolveConfig({}, { RIUS_SAMPLE_RATE: "-1" }).sampleRate).toBe(0.0);
    expect(resolveConfig({}, { RIUS_SAMPLE_RATE: "abc" }).sampleRate).toBe(1.0);
  });

  it("strips a trailing slash from the endpoint so path joining stays correct", () => {
    expect(resolveConfig({ endpoint: "https://x.test/" }, {}).endpoint).toBe("https://x.test");
  });

  it("treats empty string and unrecognized values for RIUS_CAPTURE_CONTENT as default (true), not false", () => {
    expect(resolveConfig({}, { RIUS_CAPTURE_CONTENT: "" }).captureContent).toBe(true);
    expect(resolveConfig({}, { RIUS_CAPTURE_CONTENT: "enabled" }).captureContent).toBe(true);
  });

  it("recognizes explicit negative values for RIUS_CAPTURE_CONTENT", () => {
    expect(resolveConfig({}, { RIUS_CAPTURE_CONTENT: "false" }).captureContent).toBe(false);
    expect(resolveConfig({}, { RIUS_CAPTURE_CONTENT: "off" }).captureContent).toBe(false);
    expect(resolveConfig({}, { RIUS_CAPTURE_CONTENT: "0" }).captureContent).toBe(false);
    expect(resolveConfig({}, { RIUS_CAPTURE_CONTENT: "no" }).captureContent).toBe(false);
  });

  it("handles case-insensitive boolean parsing for RIUS_CAPTURE_CONTENT", () => {
    expect(resolveConfig({}, { RIUS_CAPTURE_CONTENT: "FALSE" }).captureContent).toBe(false);
    expect(resolveConfig({}, { RIUS_CAPTURE_CONTENT: "TRUE" }).captureContent).toBe(true);
  });

  it("recognizes explicit positive value for RIUS_DISABLED", () => {
    expect(resolveConfig({}, { RIUS_DISABLED: "true" }).disabled).toBe(true);
  });

  it("treats unrecognized value for RIUS_DISABLED as default (false), not true", () => {
    expect(resolveConfig({}, { RIUS_DISABLED: "garbage" }).disabled).toBe(false);
  });

  it("warns when a boolean env var has an unrecognized value", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveConfig({}, { RIUS_CAPTURE_CONTENT: "invalid" });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[rius]") && expect.stringContaining("not a recognised boolean"),
    );
    warnSpy.mockRestore();
  });

  it("defaults heartbeat and partial-spans options with an empty environment", () => {
    const c = resolveConfig({}, {});
    expect(c.heartbeat).toBe(true);
    expect(c.heartbeatIntervalMs).toBe(15000);
    expect(c.partialSpans).toBe(false);
    expect(c.partialSpansDelayMs).toBe(0);
    expect(c.agentName).toBe(c.serviceName);
    expect(c.heartbeatEndpoint).toBe(`${DEFAULT_ENDPOINT}/v1/heartbeat`);
  });

  it("reads RIUS_ environment variables for heartbeat and partial-spans options", () => {
    const c = resolveConfig(
      {},
      {
        RIUS_HEARTBEAT: "false",
        RIUS_HEARTBEAT_INTERVAL: "30",
        RIUS_AGENT_NAME: "my-agent",
        RIUS_PARTIAL_SPANS: "true",
        RIUS_PARTIAL_SPANS_DELAY: "5",
      },
    );
    expect(c.heartbeat).toBe(false);
    expect(c.heartbeatIntervalMs).toBe(30000);
    expect(c.agentName).toBe("my-agent");
    expect(c.partialSpans).toBe(true);
    expect(c.partialSpansDelayMs).toBe(5000);
  });

  it("prefers explicit heartbeat and partial-spans options over the environment", () => {
    const c = resolveConfig(
      {
        heartbeat: true,
        heartbeatInterval: 20,
        agentName: "explicit-agent",
        partialSpans: false,
        partialSpansDelay: 10,
      },
      {
        RIUS_HEARTBEAT: "false",
        RIUS_HEARTBEAT_INTERVAL: "30",
        RIUS_AGENT_NAME: "from-env",
        RIUS_PARTIAL_SPANS: "true",
        RIUS_PARTIAL_SPANS_DELAY: "5",
      },
    );
    expect(c.heartbeat).toBe(true);
    expect(c.heartbeatIntervalMs).toBe(20000);
    expect(c.agentName).toBe("explicit-agent");
    expect(c.partialSpans).toBe(false);
    expect(c.partialSpansDelayMs).toBe(10000);
  });

  it("clamps an out-of-range heartbeatInterval and warns", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveConfig({ heartbeatInterval: 1 }, {}).heartbeatIntervalMs).toBe(5000);
    expect(resolveConfig({ heartbeatInterval: 999 }, {}).heartbeatIntervalMs).toBe(300000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[rius]"));
    warnSpy.mockRestore();
  });

  it("clamps an out-of-range partialSpansDelay and warns", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveConfig({ partialSpansDelay: -1 }, {}).partialSpansDelayMs).toBe(0);
    expect(resolveConfig({ partialSpansDelay: 120 }, {}).partialSpansDelayMs).toBe(60000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[rius]"));
    warnSpy.mockRestore();
  });

  it("falls back to defaults for non-numeric heartbeatInterval/partialSpansDelay env values", () => {
    expect(resolveConfig({}, { RIUS_HEARTBEAT_INTERVAL: "abc" }).heartbeatIntervalMs).toBe(15000);
    expect(resolveConfig({}, { RIUS_PARTIAL_SPANS_DELAY: "abc" }).partialSpansDelayMs).toBe(0);
  });
});
