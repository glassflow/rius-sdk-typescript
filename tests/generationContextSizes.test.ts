import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { type InitOptions, type RiusClient, init } from "../src/client.js";
import { startAsCurrentGeneration, startGeneration } from "../src/generation.js";
import { TRUNCATION_MARKER } from "../src/serde.js";

let exporter: InMemorySpanExporter;
let client: RiusClient | undefined;

function setUp(options: Partial<InitOptions> = {}) {
  exporter = new InMemorySpanExporter();
  client = init({ spanExporter: exporter, heartbeatTransport: async () => {}, ...options });
}
afterEach(async () => {
  await client?.shutdown();
  client = undefined;
});

function sizesOf(index = 0): Record<string, unknown> {
  const span = exporter.getFinishedSpans()[index];
  return JSON.parse(String(span.attributes["rius.context.sizes"]));
}

const tools = [{ type: "function", function: { name: "get_weather", parameters: {} } }];
const toolBytes = Buffer.byteLength(JSON.stringify(tools[0]));

describe("rius.context.sizes on generation spans", () => {
  it("is carried by every generation span, even one with no content set", async () => {
    setUp();
    startGeneration("manual", { model: "m" }).end();
    await startAsCurrentGeneration("scoped", { model: "m" }, async () => "ok");
    await client?.flush();
    expect(sizesOf(0)).toEqual({ v: 1 });
    expect(sizesOf(1)).toEqual({ v: 1 });
  });

  it("describes the creation-time input and tools", async () => {
    setUp();
    startGeneration("chat", {
      model: "m",
      tools,
      input: [{ role: "user", content: "héllo" }],
    }).end();
    await client?.flush();
    expect(sizesOf()).toEqual({ v: 1, t: [["get_weather", toolBytes]], i: [["u", 6]] });
  });

  it("combines input, output and tools set in any order, last write wins", async () => {
    setUp();
    const gen = startGeneration("chat", { model: "m" });
    gen.setInput([{ role: "system", content: "sys" }, "hi"]);
    gen.setOutput({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", function: { name: "get_weather", arguments: "{}" } }],
    });
    gen.setToolDefinitions(tools);
    gen.end();
    await client?.flush();
    const callPart = { type: "tool_call", id: "c1", name: "get_weather", arguments: "{}" };
    expect(sizesOf()).toEqual({
      v: 1,
      t: [["get_weather", toolBytes]],
      i: [
        ["s", 3],
        ["u", 2],
      ],
      o: [["a", 0, ["c", 0, Buffer.byteLength(JSON.stringify(callPart))]]],
    });
  });

  it("reports the full pre-truncation size of an oversized output", async () => {
    setUp();
    const big = "é".repeat(40_000); // 40 K chars > the 32 K attribute cap, 80 K bytes
    const gen = startGeneration("chat", { model: "m" });
    gen.setOutput(big);
    gen.end();
    await client?.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(String(span.attributes["gen_ai.output.messages"]).endsWith(TRUNCATION_MARKER)).toBe(
      true,
    );
    expect(sizesOf()).toEqual({ v: 1, o: [["a", 80_000]] });
  });

  it("survives captureContent: false while the content attributes are stripped", async () => {
    setUp({ captureContent: false });
    startGeneration("chat", { model: "m", tools, input: "secret" }).end();
    await client?.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.input.messages"]).toBeUndefined();
    expect(span.attributes["gen_ai.tool.definitions"]).toBeUndefined();
    expect(sizesOf()).toEqual({ v: 1, t: [["get_weather", toolBytes]], i: [["u", 6]] });
  });

  it("describes the unmasked text and is itself never masked", async () => {
    setUp({ mask: () => "[REDACTED]" });
    startGeneration("chat", { model: "m", input: "a secret of some length" }).end();
    await client?.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.input.messages"]).toBe("[REDACTED]");
    expect(sizesOf()).toEqual({ v: 1, i: [["u", 23]] });
  });

  it("does not change the JSON written to the content attributes", async () => {
    setUp();
    const gen = startGeneration("chat", { model: "m", tools });
    gen.setInput([{ role: "user", content: "hi" }]);
    gen.setOutput("yo");
    gen.end();
    await client?.flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.input.messages"]).toBe(
      '[{"role":"user","parts":[{"type":"text","content":"hi"}]}]',
    );
    expect(span.attributes["gen_ai.output.messages"]).toBe(
      '[{"role":"assistant","parts":[{"type":"text","content":"yo"}]}]',
    );
    expect(span.attributes["gen_ai.tool.definitions"]).toBe(JSON.stringify(tools));
  });
});
