import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { instrumentMcpClient } from "../src/instrumentationMcp.js";

class FakeClient {
  async callTool(params: { name: string; arguments?: unknown }): Promise<unknown> {
    if (params.name === "explode") throw new Error("tool failed");
    if (params.name === "asks") {
      return { result_type: "input_required", input_requests: [{ prompt: "<PII>" }] };
    }
    if (params.name === "asks-camel") {
      return { resultType: "input_required", inputRequests: [{ prompt: "<PII>" }] };
    }
    return { content: [{ type: "text", text: "ok" }] };
  }
}

// Captured before any test wraps FakeClient, so it is the one true unwrapped
// reference to compare against later. Capturing this inside a test body would
// see whatever beforeEach just installed (the current wrapper), not the true
// original, since beforeEach runs before the test body.
const trueOriginalCallTool = FakeClient.prototype.callTool;

let exporter: InMemorySpanExporter;
let client: RiusClient;
let uninstrument: () => void;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  client = init({ spanExporter: exporter });
  uninstrument = instrumentMcpClient(FakeClient);
});
afterEach(async () => {
  uninstrument();
  await client.shutdown();
});

describe("instrumentMcpClient", () => {
  it("creates a TOOL span named after the tool", async () => {
    await new FakeClient().callTool({ name: "add", arguments: { a: 1 } });
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.name).toBe("add");
    expect(span.attributes["openinference.span.kind"]).toBe("TOOL");
    expect(span.attributes["gen_ai.tool.name"]).toBe("add");
    expect(span.attributes["gen_ai.operation.name"]).toBe("execute_tool");
  });

  it("marks an interim input-required round and records no output", async () => {
    await new FakeClient().callTool({ name: "asks" });
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["mcp.result_type"]).toBe("input_required");
    expect(span.attributes["output.value"]).toBeUndefined();
  });

  it("detects the camelCase spelling of the interim result type", async () => {
    await new FakeClient().callTool({ name: "asks-camel" });
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["mcp.result_type"]).toBe("input_required");
    expect(span.attributes["output.value"]).toBeUndefined();
  });

  it("records output and no result-type marker on a final round", async () => {
    await new FakeClient().callTool({ name: "add" });
    await client.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["mcp.result_type"]).toBeUndefined();
    expect(span.attributes["output.value"]).toContain("ok");
  });

  it("marks failures as errors and rethrows", async () => {
    await expect(new FakeClient().callTool({ name: "explode" })).rejects.toThrow("tool failed");
    await client.flush();
    expect(exporter.getFinishedSpans()[0].status.code).toBe(2);
  });

  it("restores the original method on uninstrument", async () => {
    uninstrument();
    expect(FakeClient.prototype.callTool).toBe(trueOriginalCallTool);
    uninstrument = () => {};
  });

  // Proves the gate's finding (Client.prototype.callTool is writable and
  // configurable in @modelcontextprotocol/sdk@1.30.0) still holds against the
  // real class shipped by the installed package, not just a probe run once
  // against a fake.
  it("patches and restores the real SDK Client.prototype.callTool", () => {
    const trueOriginal = Client.prototype.callTool;
    const restore = instrumentMcpClient(Client);
    expect(Client.prototype.callTool).not.toBe(trueOriginal);
    restore();
    expect(Client.prototype.callTool).toBe(trueOriginal);
  });

  // Guards against wrapper stacking: instrumenting twice must not leave a
  // wrapper-of-a-wrapper that a single uninstrument() cannot fully undo.
  it("does not stack wrappers when instrumented twice", () => {
    const trueOriginal = Client.prototype.callTool;
    const restoreFirst = instrumentMcpClient(Client);
    const wrappedOnce = Client.prototype.callTool;
    const restoreSecond = instrumentMcpClient(Client);

    // Idempotent: the second call detects the existing wrapper and does not
    // add another layer on top of it.
    expect(Client.prototype.callTool).toBe(wrappedOnce);

    restoreSecond();
    expect(Client.prototype.callTool).toBe(trueOriginal);

    restoreFirst();
    expect(Client.prototype.callTool).toBe(trueOriginal);
  });
});
