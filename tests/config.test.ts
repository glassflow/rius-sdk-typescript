import { describe, expect, it } from "vitest";
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
});
