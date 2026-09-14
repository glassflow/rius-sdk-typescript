import { InMemorySpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RiusClient, init, spanProcessorSink } from "../src/client.js";
import { startAsCurrentGeneration, startGeneration } from "../src/generation.js";
import { VERSION } from "../src/index.js";
import { instrumentMcpClient } from "../src/instrumentationMcp.js";
import { observe } from "../src/observe.js";
import { MAX_ATTR_CHARS, TRUNCATION_MARKER, toAttributeValue } from "../src/serde.js";
import { startSpan } from "../src/spans.js";

/**
 * Wire parity with the Python SDK, which is the reference for shapes: what
 * lands in ClickHouse must not depend on which SDK produced it.
 */

let exporter: InMemorySpanExporter;
let client: RiusClient;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  client = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
});
afterEach(async () => {
  await client.shutdown();
});

describe("serialized payload cap", () => {
  it("is 32 KiB, shared with Python", () => {
    expect(MAX_ATTR_CHARS).toBe(32 * 1024);
  });

  it("truncates a large payload with the same marker Python uses", () => {
    const text = toAttributeValue(Array.from({ length: 1000 }, () => "y".repeat(1000)));
    expect(typeof text).toBe("string");
    expect((text as string).endsWith(TRUNCATION_MARKER)).toBe(true);
    expect((text as string).length).toBeLessThanOrEqual(MAX_ATTR_CHARS + TRUNCATION_MARKER.length);
    expect(TRUNCATION_MARKER).toBe("…(truncated)");
  });

  it("bounds a bare string too", () => {
    const text = toAttributeValue("z".repeat(MAX_ATTR_CHARS + 5)) as string;
    expect(text).toBe(`${"z".repeat(MAX_ATTR_CHARS)}${TRUNCATION_MARKER}`);
  });
});

describe("resource and scope identity", () => {
  it("stamps telemetry.distro.name/version on the resource", async () => {
    startSpan("s").end();
    await client.flush();
    const attrs = exporter.getFinishedSpans()[0].resource.attributes;
    expect(attrs["telemetry.distro.name"]).toBe("glassflow-rius");
    expect(attrs["telemetry.distro.version"]).toBe(VERSION);
  });

  it("versions the SDK tracer scope", async () => {
    startSpan("s").end();
    await client.flush();
    const scope = exporter.getFinishedSpans()[0].instrumentationScope;
    expect(scope.name).toBe("glassflow");
    expect(scope.version).toBe(VERSION);
  });
});

describe("observe input shape", () => {
  it("records {args, kwargs} like Python, kwargs always empty here", async () => {
    const fn = observe(async (a: string, b: number) => `${a}${b}`, { name: "fn" });
    await fn("x", 1);
    await client.flush();
    expect(exporter.getFinishedSpans()[0].attributes["input.value"]).toBe(
      '{"args":["x",1],"kwargs":{}}',
    );
  });
});

describe("generation operation option", () => {
  it("overrides gen_ai.operation.name, default stays chat", async () => {
    startGeneration("a", { model: "m" }).end();
    startGeneration("b", { model: "m", operation: "text_completion" }).end();
    await startAsCurrentGeneration("c", { operation: "embeddings" }, async () => {});
    await client.flush();
    const byName = new Map(exporter.getFinishedSpans().map((s) => [s.name, s]));
    expect(byName.get("a")?.attributes["gen_ai.operation.name"]).toBe("chat");
    expect(byName.get("b")?.attributes["gen_ai.operation.name"]).toBe("text_completion");
    expect(byName.get("c")?.attributes["gen_ai.operation.name"]).toBe("embeddings");
  });
});

describe("message normalisation to {role, parts}", () => {
  async function inOut(input: unknown, output: unknown) {
    const gen = startGeneration("g", { model: "m", input });
    gen.setOutput(output);
    gen.end();
    await client.flush();
    const attrs = exporter.getFinishedSpans()[0].attributes;
    return {
      input: JSON.parse(attrs["gen_ai.input.messages"] as string),
      output: JSON.parse(attrs["gen_ai.output.messages"] as string),
    };
  }

  it("wraps bare strings as user / assistant text parts", async () => {
    const { input, output } = await inOut("hi", "hello");
    expect(input).toEqual([{ role: "user", parts: [{ type: "text", content: "hi" }] }]);
    expect(output).toEqual([{ role: "assistant", parts: [{ type: "text", content: "hello" }] }]);
  });

  it("converts OpenAI-style {role, content} messages", async () => {
    const { input } = await inOut(
      [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
      [],
    );
    expect(input).toEqual([
      { role: "system", parts: [{ type: "text", content: "be brief" }] },
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
  });

  it("passes already-conformant messages through, defaulting a missing role", async () => {
    const { input } = await inOut([{ parts: [{ type: "text", content: "x" }] }], []);
    expect(input).toEqual([{ role: "user", parts: [{ type: "text", content: "x" }] }]);
  });

  it("turns OpenAI tool_calls into tool_call parts and tool replies into tool_call_response parts", async () => {
    const { output } = await inOut(
      [],
      [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", function: { name: "add", arguments: '{"a":1}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "3" },
      ],
    );
    expect(output).toEqual([
      {
        role: "assistant",
        parts: [{ type: "tool_call", id: "call_1", name: "add", arguments: '{"a":1}' }],
      },
      { role: "tool", parts: [{ type: "tool_call_response", id: "call_1", response: "3" }] },
    ]);
  });

  it("converts multimodal content lists part by part", async () => {
    const { input } = await inOut(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "http://x/y.png" } },
          ],
        },
      ],
      [],
    );
    expect(input).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", content: "what is this" },
          { type: "image_url", image_url: { url: "http://x/y.png" } },
        ],
      },
    ]);
  });

  it("falls back to a serialized text part for anything else", async () => {
    const { input } = await inOut([42], []);
    expect(input).toEqual([{ role: "user", parts: [{ type: "text", content: "42" }] }]);
  });
});

describe("MCP output shape", () => {
  class FakeClient {
    async callTool(params: { name: string; arguments?: unknown }): Promise<unknown> {
      if (params.name === "structured") return { content: [], structuredContent: { result: 5 } };
      if (params.name === "one-text") return { content: [{ type: "text", text: "5" }] };
      if (params.name === "two-texts")
        return {
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        };
      return { content: [] };
    }
  }

  it("unwraps structured content, a single text block, and lists several", async () => {
    const restore = instrumentMcpClient(FakeClient);
    try {
      const c = new FakeClient();
      await c.callTool({ name: "structured" });
      await c.callTool({ name: "one-text" });
      await c.callTool({ name: "two-texts" });
    } finally {
      restore();
    }
    await client.flush();
    const byName = new Map(exporter.getFinishedSpans().map((s) => [s.name, s.attributes]));
    expect(byName.get("execute_tool structured")?.["output.value"]).toBe('{"result":5}');
    expect(byName.get("execute_tool one-text")?.["output.value"]).toBe("5");
    expect(byName.get("execute_tool two-texts")?.["output.value"]).toBe('["a","b"]');
  });

  it("sets the tool name at span start so pending snapshots carry it", async () => {
    const seen: Record<string, Record<string, unknown>> = {};
    const recorder: SpanProcessor = {
      onStart(span) {
        seen[span.name] = { ...span.attributes };
      },
      onEnd() {},
      async forceFlush() {},
      async shutdown() {},
    };
    spanProcessorSink(client).add(recorder);
    const restore = instrumentMcpClient(FakeClient);
    try {
      await new FakeClient().callTool({ name: "one-text" });
    } finally {
      restore();
    }
    expect(seen["execute_tool one-text"]?.["gen_ai.tool.name"]).toBe("one-text");
    expect(seen["execute_tool one-text"]?.["openinference.span.kind"]).toBe("TOOL");
  });
});
