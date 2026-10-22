import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { init, type RiusClient } from "../src/client.js";
import { startGeneration } from "../src/generation.js";
import { startSpan } from "../src/spans.js";

// `update` records input and output in one call, as the Python SDK's
// `Observation.update` and `Generation.update` do: each goes through the
// handle's own setter, and an absent one is left alone.

let exporter: InMemorySpanExporter;
let client: RiusClient;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  client = init({ spanExporter: exporter, heartbeat: false });
});
afterEach(async () => {
  await client.shutdown();
});

async function attributes() {
  await client.flush();
  return exporter.getFinishedSpans()[0].attributes;
}

describe("Observation.update", () => {
  it("records input and output through the setters, and chains", async () => {
    const span = startSpan("step");
    expect(span.update({ input: { q: 1 }, output: "done" })).toBe(span);
    span.end();
    const attrs = await attributes();
    expect(attrs["input.value"]).toBe('{"q":1}');
    expect(attrs["output.value"]).toBe("done");
  });

  it("leaves an absent or null field alone, as Python skips None", async () => {
    const span = startSpan("step", { input: "kept" });
    span.update({ input: null, output: "only output" });
    span.update({});
    span.end();
    const attrs = await attributes();
    expect(attrs["input.value"]).toBe("kept");
    expect(attrs["output.value"]).toBe("only output");
  });
});

describe("Generation.update", () => {
  it("records messages through the generation's own setters", async () => {
    const generation = startGeneration("chat", { model: "m" });
    generation.update({
      input: [{ role: "user", content: "hi" }],
      output: [{ role: "assistant", content: "hello" }],
    });
    generation.end();
    const attrs = await attributes();
    expect(attrs["gen_ai.input.messages"]).toContain('"hi"');
    expect(attrs["gen_ai.output.messages"]).toContain('"hello"');
    expect(attrs["input.value"]).toBeUndefined();
  });
});
