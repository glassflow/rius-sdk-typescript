import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { MaskingSpanExporter, isContentKey } from "../src/masking.js";

function span(attributes: Record<string, unknown>): ReadableSpan {
  return { attributes } as unknown as ReadableSpan;
}

interface Bag {
  name?: string;
  attributes?: Record<string, unknown>;
}

/** A span carrying events and/or links as well as its own attributes. */
function richSpan(parts: {
  attributes?: Record<string, unknown>;
  events?: Bag[];
  links?: Bag[];
}): ReadableSpan {
  return {
    attributes: parts.attributes ?? {},
    events: parts.events,
    links: parts.links,
  } as unknown as ReadableSpan;
}

class Capture implements SpanExporter {
  seen: ReadableSpan[] = [];
  export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
    this.seen = spans;
    cb({ code: ExportResultCode.SUCCESS });
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

describe("isContentKey", () => {
  it("matches exact keys, prefixes and suffixes", () => {
    expect(isContentKey("input.value")).toBe(true);
    expect(isContentKey("llm.input_messages.0.message.content")).toBe(true);
    expect(isContentKey("retrieval.documents.0.document.content")).toBe(true);
    expect(isContentKey("gen_ai.request.model")).toBe(false);
    expect(isContentKey("retrieval.documents.0.document.score")).toBe(false);
  });
});

describe("MaskingSpanExporter", () => {
  it("strips content but keeps metadata when captureContent is false", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: false }).export(
      [span({ "input.value": "secret", "gen_ai.request.model": "gpt-4o" })],
      () => {},
    );
    expect(inner.seen[0].attributes["input.value"]).toBeUndefined();
    expect(inner.seen[0].attributes["gen_ai.request.model"]).toBe("gpt-4o");
  });

  it("strips tool definitions and descriptions, keeps the tool name", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: false }).export(
      [
        span({
          "gen_ai.tool.definitions": '[{"name":"q","description":"secret"}]',
          "gen_ai.tool.description": "runs SQL against the billing db",
          "gen_ai.tool.name": "query_billing",
        }),
      ],
      () => {},
    );
    expect(inner.seen[0].attributes["gen_ai.tool.definitions"]).toBeUndefined();
    expect(inner.seen[0].attributes["gen_ai.tool.description"]).toBeUndefined();
    // identity, not content: the tool NAME survives, so traces stay navigable
    expect(inner.seen[0].attributes["gen_ai.tool.name"]).toBe("query_billing");
  });

  it("applies a mask to content values only", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, {
      captureContent: true,
      mask: () => "[REDACTED]",
    }).export([span({ "output.value": "secret", "gen_ai.request.model": "gpt-4o" })], () => {});
    expect(inner.seen[0].attributes["output.value"]).toBe("[REDACTED]");
    expect(inner.seen[0].attributes["gen_ai.request.model"]).toBe("gpt-4o");
  });

  it("passes the key to a mask that wants it", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, {
      captureContent: true,
      mask: (_v, ctx) => `masked:${ctx?.key}`,
    }).export([span({ "input.value": "secret" })], () => {});
    expect(inner.seen[0].attributes["input.value"]).toBe("masked:input.value");
  });

  it("replaces the value with a marker rather than propagating a throwing mask", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, {
      captureContent: true,
      mask: () => {
        throw new Error("bad mask");
      },
    }).export([span({ "input.value": "secret" })], () => {});
    expect(inner.seen[0].attributes["input.value"]).toBe("[mask error]");
  });

  it("strips a suffix-matched key while its sibling metadata attribute survives", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: false }).export(
      [
        span({
          "retrieval.documents.0.document.content": "secret text",
          "retrieval.documents.0.document.score": 0.87,
        }),
      ],
      () => {},
    );
    expect(inner.seen[0].attributes["retrieval.documents.0.document.content"]).toBeUndefined();
    expect(inner.seen[0].attributes["retrieval.documents.0.document.score"]).toBe(0.87);
  });

  it("passes through a span with no content attributes unchanged", () => {
    const inner = new Capture();
    const attributes = { "gen_ai.request.model": "gpt-4o", "http.status_code": 200 };
    new MaskingSpanExporter(inner, { captureContent: false }).export([span(attributes)], () => {});
    expect(inner.seen[0].attributes).toEqual(attributes);
  });
});

describe("MaskingSpanExporter events and links", () => {
  it("strips content carried by an event attribute when captureContent is false", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: false }).export(
      [
        richSpan({
          events: [
            {
              name: "gen_ai.user.message",
              attributes: { "gen_ai.input.messages": "secret", "gen_ai.request.model": "gpt-4o" },
            },
          ],
        }),
      ],
      () => {},
    );
    const event = inner.seen[0].events[0];
    expect(event.attributes?.["gen_ai.input.messages"]).toBeUndefined();
    expect(event.attributes?.["gen_ai.request.model"]).toBe("gpt-4o");
  });

  it("strips content carried by a link attribute when captureContent is false", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: false }).export(
      [richSpan({ links: [{ attributes: { "input.value": "secret", "link.rank": 1 } }] })],
      () => {},
    );
    const link = inner.seen[0].links[0];
    expect(link.attributes?.["input.value"]).toBeUndefined();
    expect(link.attributes?.["link.rank"]).toBe(1);
  });

  it("keeps the exception event and its type but strips message and stacktrace", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: false }).export(
      [
        richSpan({
          events: [
            {
              name: "exception",
              attributes: {
                "exception.type": "BadRequestError",
                "exception.message": '400: {"messages":[{"content":"<PII>"}]}',
                "exception.stacktrace": "at call (<PII>)",
              },
            },
          ],
        }),
      ],
      () => {},
    );
    const events = inner.seen[0].events;
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("exception");
    expect(events[0].attributes?.["exception.type"]).toBe("BadRequestError");
    expect(events[0].attributes?.["exception.message"]).toBeUndefined();
    expect(events[0].attributes?.["exception.stacktrace"]).toBeUndefined();
  });

  it("keeps exception message and stacktrace under the default captureContent", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: true, mask: () => "[REDACTED]" }).export(
      [
        richSpan({
          events: [
            {
              name: "exception",
              attributes: { "exception.message": "boom", "exception.stacktrace": "at x" },
            },
          ],
        }),
      ],
      () => {},
    );
    const event = inner.seen[0].events[0];
    expect(event.attributes?.["exception.message"]).toBe("boom");
    expect(event.attributes?.["exception.stacktrace"]).toBe("at x");
  });

  it("applies a mask to event and link content attributes", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: true, mask: () => "[REDACTED]" }).export(
      [
        richSpan({
          events: [{ name: "gen_ai.choice", attributes: { "gen_ai.output.messages": "secret" } }],
          links: [{ attributes: { "output.value": "secret" } }],
        }),
      ],
      () => {},
    );
    expect(inner.seen[0].events[0].attributes?.["gen_ai.output.messages"]).toBe("[REDACTED]");
    expect(inner.seen[0].links[0].attributes?.["output.value"]).toBe("[REDACTED]");
  });

  it("leaves a span with no events or links alone", () => {
    const inner = new Capture();
    const attributes = { "input.value": "secret", "gen_ai.request.model": "gpt-4o" };
    new MaskingSpanExporter(inner, { captureContent: false }).export(
      [richSpan({ attributes })],
      () => {},
    );
    expect(inner.seen[0].events).toBeUndefined();
    expect(inner.seen[0].links).toBeUndefined();
    expect(inner.seen[0].attributes["input.value"]).toBeUndefined();
    expect(inner.seen[0].attributes["gen_ai.request.model"]).toBe("gpt-4o");
  });
});

describe("wrapper tool-definition and Vercel ai.* coverage", () => {
  // Pinned empirically against the bundled instrumentations (2026-09-14):
  // every OpenInference path emits llm.tools.{i}.tool.json_schema, and the
  // vercel-ai path leaves raw ai.* keys carrying full messages, response
  // content and tool definitions.
  it("strips llm.tools.* and the ai.* content family, keeps identity", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: false }).export(
      [
        span({
          "llm.tools.0.tool.json_schema": '{"name":"secret_tool"}',
          "llm.tools": '[{"name":"secret_tool"}]',
          "ai.prompt": '{"prompt":"secret"}',
          "ai.prompt.messages": '[{"role":"user","content":"secret"}]',
          "ai.prompt.tools": '["secret schema"]',
          "ai.response.text": "secret answer",
          "ai.response.object": '{"secret":1}',
          "ai.toolCall.args": '{"city":"secret"}',
          "ai.toolCall.result": '{"weather":"secret"}',
          "ai.toolCall.name": "get_weather",
          "ai.response.model": "gpt-test",
        }),
      ],
      () => {},
    );
    const attributes = inner.seen[0].attributes as Record<string, unknown>;
    for (const key of [
      "llm.tools.0.tool.json_schema",
      "llm.tools",
      "ai.prompt",
      "ai.prompt.messages",
      "ai.prompt.tools",
      "ai.response.text",
      "ai.response.object",
      "ai.toolCall.args",
      "ai.toolCall.result",
    ]) {
      expect(attributes[key], key).toBeUndefined();
    }
    expect(attributes["ai.toolCall.name"]).toBe("get_weather");
    expect(attributes["ai.response.model"]).toBe("gpt-test");
  });
});

describe("llm.invocation_parameters redaction", () => {
  // litellm and langchain embed the request tools/functions arrays INSIDE
  // llm.invocation_parameters; the direct openai/anthropic instrumentors do
  // not. The key mixes identity (sampling params) with content, so exactly
  // the tools/functions members go, and the rest survives.
  it("removes tools and functions members, keeps sampling params", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: false }).export(
      [
        span({
          "llm.invocation_parameters":
            '{"model":"gpt-test","temperature":0.2,"tools":[{"name":"secret_tool"}],"functions":[{"name":"legacy"}]}',
        }),
      ],
      () => {},
    );
    const kept = JSON.parse(
      String((inner.seen[0].attributes as Record<string, unknown>)["llm.invocation_parameters"]),
    );
    expect(kept).toEqual({ model: "gpt-test", temperature: 0.2 });
  });

  it("leaves a tools-free payload byte-identical", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: false }).export(
      [span({ "llm.invocation_parameters": '{"temperature": 0.1}' })],
      () => {},
    );
    expect((inner.seen[0].attributes as Record<string, unknown>)["llm.invocation_parameters"]).toBe(
      '{"temperature": 0.1}',
    );
  });

  it("drops an unparseable payload whole (fail closed)", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: false }).export(
      [span({ "llm.invocation_parameters": "not json {" })],
      () => {},
    );
    expect(
      (inner.seen[0].attributes as Record<string, unknown>)["llm.invocation_parameters"],
    ).toBeUndefined();
  });

  it("redacts under a mask too: a mask declares content sensitive", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: true, mask: () => "[masked]" }).export(
      [
        span({
          "llm.invocation_parameters": '{"temperature":0.2,"tools":[{"name":"secret_tool"}]}',
        }),
      ],
      () => {},
    );
    const kept = JSON.parse(
      String((inner.seen[0].attributes as Record<string, unknown>)["llm.invocation_parameters"]),
    );
    expect(kept).toEqual({ temperature: 0.2 });
  });

  it("does not touch the key when no sanitization is configured", () => {
    const inner = new Capture();
    const raw = '{"temperature":0.2,"tools":[{"name":"tool"}]}';
    new MaskingSpanExporter(inner, { captureContent: true }).export(
      [span({ "llm.invocation_parameters": raw })],
      () => {},
    );
    expect((inner.seen[0].attributes as Record<string, unknown>)["llm.invocation_parameters"]).toBe(
      raw,
    );
  });
});

describe("GenAI semconv tool-call / system keys and OpenInference TOOL keys", () => {
  const leaked = [
    "gen_ai.system_instructions",
    "gen_ai.tool.call.arguments",
    "gen_ai.tool.call.result",
    "tool.description",
    "tool.parameters",
    "ai.response.reasoning",
    "ai.response.toolCalls",
    "ai.response.files",
    "ai.value",
    "ai.values",
    "ai.documents",
    "ai.schema",
    "ai.schema.description",
  ];

  it("classifies every key the ai v7 / @ai-sdk/otel path emits with content as content", () => {
    for (const key of leaked) expect(isContentKey(key), key).toBe(true);
    for (const key of [
      "gen_ai.tool.name",
      "gen_ai.tool.call.id",
      "ai.toolCall.name",
      "ai.model.id",
    ]) {
      expect(isContentKey(key), key).toBe(false);
    }
  });

  it("strips them under captureContent: false and keeps identity siblings", () => {
    const inner = new Capture();
    const exporter = new MaskingSpanExporter(inner, { captureContent: false });
    const attributes: Record<string, unknown> = Object.fromEntries(
      leaked.map((k) => [k, "SECRET"]),
    );
    attributes["gen_ai.tool.name"] = "get_weather";
    attributes["gen_ai.tool.call.id"] = "call_1";
    exporter.export([span(attributes)], () => {});
    const out = inner.seen[0].attributes as Record<string, unknown>;
    for (const key of leaked) expect(out[key], key).toBeUndefined();
    expect(out["gen_ai.tool.name"]).toBe("get_weather");
    expect(out["gen_ai.tool.call.id"]).toBe("call_1");
  });
});

describe("span status description", () => {
  function errorSpan(message: string): ReadableSpan {
    return {
      attributes: {},
      status: { code: 2 /* SpanStatusCode.ERROR */, message },
    } as unknown as ReadableSpan;
  }

  it("runs the mask over the status message and passes the key", () => {
    const inner = new Capture();
    const seenKeys: string[] = [];
    const exporter = new MaskingSpanExporter(inner, {
      captureContent: true,
      mask: (_v, ctx) => {
        seenKeys.push(ctx?.key ?? "");
        return "***";
      },
    });
    exporter.export([errorSpan("400: messages=[{content:'SSN 123-45-6789'}]")], () => {});
    expect(inner.seen[0].status.message).toBe("***");
    expect(inner.seen[0].status.code).toBe(2);
    expect(seenKeys).toContain("status.description");
  });

  it("blanks the status message under captureContent: false and keeps the code", () => {
    const inner = new Capture();
    const exporter = new MaskingSpanExporter(inner, { captureContent: false });
    exporter.export([errorSpan("secret")], () => {});
    expect(inner.seen[0].status.message).toBeUndefined();
    expect(inner.seen[0].status.code).toBe(2);
  });

  it("leaves the status message alone when nothing sanitizes", () => {
    const inner = new Capture();
    const exporter = new MaskingSpanExporter(inner, { captureContent: true });
    exporter.export([errorSpan("secret")], () => {});
    expect(inner.seen[0].status.message).toBe("secret");
  });
});

describe("metadata.* mirrors from the Vercel transform", () => {
  it("treats metadata.<key> as content exactly when <key> is", () => {
    expect(isContentKey("metadata.gen_ai.system_instructions")).toBe(true);
    expect(isContentKey("metadata.gen_ai.input.messages")).toBe(true);
    expect(isContentKey("metadata.llm.input_messages.0.message.content")).toBe(true);
    expect(isContentKey("metadata.gen_ai.tool.name")).toBe(false);
    expect(isContentKey("metadata.ai.model.id")).toBe(false);
  });

  it("strips the mirrored copy under captureContent: false", () => {
    const inner = new Capture();
    const exporter = new MaskingSpanExporter(inner, { captureContent: false });
    exporter.export(
      [
        span({
          "metadata.gen_ai.system_instructions": "SECRET",
          "metadata.gen_ai.tool.name": "get_weather",
        }),
      ],
      () => {},
    );
    const out = inner.seen[0].attributes as Record<string, unknown>;
    expect(out["metadata.gen_ai.system_instructions"]).toBeUndefined();
    expect(out["metadata.gen_ai.tool.name"]).toBe("get_weather");
  });
});

describe("request-parameter namespaces", () => {
  const tools = '[{"description":"SECRET"}]';

  it("keeps both namespaces under captureContent: false", () => {
    // Request parameters are not content: a caller parameter in rius.request
    // survives exactly as a spec one in gen_ai.request does.
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: false }).export(
      [span({ "gen_ai.request.temperature": 0.7, "rius.request.my_custom_knob": 3 })],
      () => {},
    );
    expect(inner.seen[0].attributes["gen_ai.request.temperature"]).toBe(0.7);
    expect(inner.seen[0].attributes["rius.request.my_custom_knob"]).toBe(3);
  });

  it("strips tool definitions from both namespaces under captureContent: false", () => {
    // Three routes reach the same definitions (gen_ai.tool.definitions, the
    // tools member of llm.invocation_parameters, and a `tools` model
    // parameter), and they must not disagree about whether they are protected.
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: false }).export(
      [
        span({
          "rius.request.tools": tools,
          "rius.request.functions": tools,
          "gen_ai.request.tools": tools,
          "gen_ai.request.functions": tools,
          // The scalar knobs around them are identity and must survive.
          "gen_ai.request.temperature": 0.7,
          "rius.request.my_custom_knob": 3,
        }),
      ],
      () => {},
    );
    expect(inner.seen[0].attributes).toEqual({
      "gen_ai.request.temperature": 0.7,
      "rius.request.my_custom_knob": 3,
    });
  });

  it("masks tool definitions in a request namespace and leaves the knobs alone", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: true, mask: () => "***" }).export(
      [span({ "rius.request.tools": tools, "gen_ai.request.temperature": 0.7 })],
      () => {},
    );
    expect(inner.seen[0].attributes["rius.request.tools"]).toBe("***");
    expect(inner.seen[0].attributes["gen_ai.request.temperature"]).toBe(0.7);
  });
});
