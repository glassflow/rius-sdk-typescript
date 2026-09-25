import { SpanStatusCode } from "@opentelemetry/api";
import type { AttributeValue, Attributes } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  type Span,
  type TimedEvent,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import {
  INVOCATION_PARAMETER_MEMBERS,
  NORMALIZATION_RULES,
  NormalizingSpanProcessor,
  OPENINFERENCE_FIRST_TOKEN_EVENT,
  PROVIDER_NAME_ALIASES,
} from "../src/normalize.js";
import { SpanKind, kindForOperation, operationForKind } from "../src/semconv.js";
import { startSpan } from "../src/spans.js";

/**
 * The OpenInference mappings, ported from the Python SDK so both put the same
 * canonical span on the wire for the same input.
 *
 * The assertions are ported BY HAND, not run from shared fixture files: the
 * Python golden-fixture ticket has not landed, so there are no files to run.
 * Where the two SDKs' instrumentations differ, the difference is pinned here
 * with a test rather than left implicit.
 */

/** An ended span carrying an attribute bag, optionally events and a status. */
function endedSpan(
  attributes: Attributes,
  extra: {
    events?: TimedEvent[];
    status?: ReadableSpan["status"];
    startTime?: [number, number];
  } = {},
): ReadableSpan {
  return {
    attributes,
    events: extra.events ?? [],
    status: extra.status ?? { code: SpanStatusCode.UNSET },
    startTime: extra.startTime ?? [0, 0],
  } as unknown as ReadableSpan;
}

/** A starting span with the mutable surface the processor uses at onStart. */
function startingSpan(attributes: Attributes): Span {
  const bag = attributes as Record<string, AttributeValue>;
  return {
    attributes: bag,
    setAttribute(key: string, value: AttributeValue) {
      bag[key] = value;
      return this;
    },
  } as unknown as Span;
}

/** The shipped table over one bag at onEnd; the mutated bag comes back. */
function normalized(attributes: Attributes, extra?: Parameters<typeof endedSpan>[1]): Attributes {
  new NormalizingSpanProcessor().onEnd(endedSpan(attributes, extra));
  return attributes;
}

describe("a whole openai chat span", () => {
  it("comes out as the complete canonical set", () => {
    expect(
      normalized({
        "openinference.span.kind": "LLM",
        "llm.provider": "openai",
        "llm.model_name": "gpt-4o-2026-08-06",
        "llm.token_count.prompt": 1_024,
        "llm.token_count.completion": 96,
        "llm.token_count.total": 1_120,
        "llm.finish_reason": "stop",
        "llm.token_count.prompt_details.cache_read": 512,
        "llm.token_count.completion_details.reasoning": 64,
        "llm.invocation_parameters": JSON.stringify({
          model: "gpt-4o",
          temperature: 0.2,
          max_tokens: 256,
          stream: true,
          response_format: { type: "json_object" },
        }),
        "input.value": "what is 2+2",
      }),
    ).toEqual({
      "openinference.span.kind": "LLM",
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.response.finish_reasons": ["stop"],
      "gen_ai.usage.input_tokens": 1_024,
      "gen_ai.usage.output_tokens": 96,
      "gen_ai.usage.cache_read.input_tokens": 512,
      "gen_ai.usage.reasoning.output_tokens": 64,
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.request.temperature": 0.2,
      "gen_ai.request.max_tokens": 256,
      "gen_ai.request.stream": true,
      // Unmapped sources ride through under their own names: llm.model_name
      // means different things per instrumentation, llm.token_count.total is
      // derivable, and response_format is lossy against gen_ai.output.type.
      "llm.model_name": "gpt-4o-2026-08-06",
      "llm.token_count.total": 1_120,
      "llm.invocation_parameters": JSON.stringify({ response_format: { type: "json_object" } }),
      "input.value": "what is 2+2",
    });
  });
});

describe("a whole anthropic messages span", () => {
  it("uses the explicit request/response model pair the anthropic path emits", () => {
    expect(
      normalized({
        "openinference.span.kind": "LLM",
        "llm.provider": "anthropic",
        "llm.system": "anthropic",
        "llm.request.model_name": "claude-sonnet-4-5",
        "llm.response.model_name": "claude-sonnet-4-5-20260929",
        "llm.token_count.prompt": 2_000,
        "llm.token_count.completion": 150,
        "llm.token_count.prompt_details.cache_read": 1_500,
        "llm.token_count.prompt_details.cache_write": 300,
      }),
    ).toEqual({
      "openinference.span.kind": "LLM",
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-sonnet-4-5",
      "gen_ai.response.model": "claude-sonnet-4-5-20260929",
      "gen_ai.usage.input_tokens": 2_000,
      "gen_ai.usage.output_tokens": 150,
      "gen_ai.usage.cache_read.input_tokens": 1_500,
      "gen_ai.usage.cache_write.input_tokens": 300,
      // NOT the provider: for Azure OpenAI the two differ (provider = azure,
      // system = openai).
      "llm.system": "anthropic",
    });
  });

  it("does NOT sum the cache counts into the input total", () => {
    // Every bundled instrumentation already reports llm.token_count.prompt
    // inclusive of the cache counts, so summing again double-counts every
    // cached token. 2000 is the whole input; 1500 and 300 are subsets of it.
    const out = normalized({
      "llm.token_count.prompt": 2_000,
      "llm.token_count.prompt_details.cache_read": 1_500,
      "llm.token_count.prompt_details.cache_write": 300,
    });
    expect(out["gen_ai.usage.input_tokens"]).toBe(2_000);
  });
});

describe("per family", () => {
  it("never overwrites a canonical key a producer already set", () => {
    const out = normalized({
      "gen_ai.usage.input_tokens": 7,
      "llm.token_count.prompt": 999,
    });
    expect(out["gen_ai.usage.input_tokens"]).toBe(7);
  });

  it("deletes the mapped source even when the native key won", () => {
    const out = normalized({
      "gen_ai.usage.input_tokens": 7,
      "llm.token_count.prompt": 999,
    });
    expect(out["llm.token_count.prompt"]).toBeUndefined();
  });

  it("leaves a source with no canonical target alone", () => {
    const out = normalized({ "llm.cost.total": 0.004, "llm.prompts": "x" });
    expect(out).toEqual({ "llm.cost.total": 0.004, "llm.prompts": "x" });
  });

  it("drops a token count that will not parse rather than emitting a string", () => {
    const out = normalized({ "llm.token_count.prompt": "not a number" });
    expect(out["gen_ai.usage.input_tokens"]).toBeUndefined();
    // The converter yielded nothing, so the rule did not fire and the only
    // copy of the value survives.
    expect(out["llm.token_count.prompt"]).toBe("not a number");
  });
});

describe("the provider value", () => {
  it("translates only the registry's own renames of the same provider", () => {
    expect(PROVIDER_NAME_ALIASES).toEqual({
      mistralai: "mistral_ai",
      xai: "x_ai",
      vertex_ai: "gcp.vertex_ai",
      gemini: "gcp.gemini",
      "az.ai.inference": "azure.ai.inference",
      "az.ai.openai": "azure.ai.openai",
    });
  });

  it.each([
    ["mistralai", "mistral_ai"],
    ["xai", "x_ai"],
    ["  XAI  ", "x_ai"],
  ])("renames %s to %s, matched case- and whitespace-insensitively", (source, expected) => {
    expect(normalized({ "llm.provider": source })["gen_ai.provider.name"]).toBe(expected);
  });

  it.each(["azure", "aws", "google"])(
    "passes %s through verbatim, because it covers several registry values",
    (source) => {
      expect(normalized({ "llm.provider": source })["gen_ai.provider.name"]).toBe(source);
    },
  );

  it("maps the deprecated gen_ai.system, which we never emit ourselves", () => {
    const out = normalized({ "gen_ai.system": "vertex_ai" });
    expect(out["gen_ai.provider.name"]).toBe("gcp.vertex_ai");
    expect(out["gen_ai.system"]).toBeUndefined();
  });

  it("prefers llm.provider when both spellings are present", () => {
    const out = normalized({ "llm.provider": "anthropic", "gen_ai.system": "vertex_ai" });
    expect(out["gen_ai.provider.name"]).toBe("anthropic");
    // Both sources go: keeping the loser would put the dialect on the wire.
    expect(out["llm.provider"]).toBeUndefined();
    expect(out["gen_ai.system"]).toBeUndefined();
  });
});

describe("the invocation-parameter bag", () => {
  it("promotes the spec members in the documented order, with their targets", () => {
    expect(INVOCATION_PARAMETER_MEMBERS.map(([member, target]) => [member, target])).toEqual([
      ["model", "gen_ai.request.model"],
      ["temperature", "gen_ai.request.temperature"],
      ["top_p", "gen_ai.request.top_p"],
      ["top_k", "gen_ai.request.top_k"],
      ["max_tokens", "gen_ai.request.max_tokens"],
      ["max_completion_tokens", "gen_ai.request.max_tokens"],
      ["frequency_penalty", "gen_ai.request.frequency_penalty"],
      ["presence_penalty", "gen_ai.request.presence_penalty"],
      ["seed", "gen_ai.request.seed"],
      ["n", "gen_ai.request.choice.count"],
      ["stop", "gen_ai.request.stop_sequences"],
      ["stop_sequences", "gen_ai.request.stop_sequences"],
      ["stream", "gen_ai.request.stream"],
      ["tool_choice", "rius.request.tool_choice"],
    ]);
  });

  it("keeps max_tokens when a request carries max_completion_tokens too", () => {
    const out = normalized({
      "llm.invocation_parameters": JSON.stringify({ max_tokens: 100, max_completion_tokens: 200 }),
    });
    expect(out["gen_ai.request.max_tokens"]).toBe(100);
    // The loser stays in the bag rather than vanishing.
    expect(out["llm.invocation_parameters"]).toBe(JSON.stringify({ max_completion_tokens: 200 }));
  });

  it("loses gen_ai.request.model to the dedicated rule, because it runs LAST", () => {
    // Order, made observable: the bag's `model` member is the request model
    // for every instrumentation but the anthropic one, which emits the
    // explicit pair. When both are present the explicit one must win, and the
    // only thing that decides it is the bag rule sitting after the model
    // rules.
    const out = normalized({
      "llm.request.model_name": "claude-sonnet-4-5",
      "llm.invocation_parameters": JSON.stringify({ model: "claude-3-haiku", seed: 1 }),
    });
    expect(out["gen_ai.request.model"]).toBe("claude-sonnet-4-5");
    // The losing member still leaves the bag: it is a duplicate at that point.
    expect(out["llm.invocation_parameters"]).toBeUndefined();
  });

  it("turns a lone stop string into the one-element list the convention wants", () => {
    const out = normalized({ "llm.invocation_parameters": JSON.stringify({ stop: "\\n\\n" }) });
    expect(out["gen_ai.request.stop_sequences"]).toEqual(["\\n\\n"]);
  });

  it("leaves a wrongly-shaped member where it was rather than coercing it", () => {
    const out = normalized({
      "llm.invocation_parameters": JSON.stringify({ temperature: "warm", top_p: 0.9 }),
    });
    expect(out["gen_ai.request.temperature"]).toBeUndefined();
    expect(out["gen_ai.request.top_p"]).toBe(0.9);
    expect(out["llm.invocation_parameters"]).toBe(JSON.stringify({ temperature: "warm" }));
  });

  it("removes a promoted member from the bag even when a native key beat it", () => {
    // It is a duplicate at that point, the same reason a mapped source goes.
    const out = normalized({
      "gen_ai.request.temperature": 0.1,
      "llm.invocation_parameters": JSON.stringify({ temperature: 0.9, custom: 1 }),
    });
    expect(out["gen_ai.request.temperature"]).toBe(0.1);
    expect(out["llm.invocation_parameters"]).toBe(JSON.stringify({ custom: 1 }));
  });

  it("drops the bag when every member was promoted", () => {
    const out = normalized({ "llm.invocation_parameters": JSON.stringify({ seed: 7 }) });
    expect(out["gen_ai.request.seed"]).toBe(7);
    expect(out["llm.invocation_parameters"]).toBeUndefined();
  });

  it("returns a bag with nothing promotable byte-identical", () => {
    const raw = JSON.stringify({ tools: [{ name: "get_weather" }], user: "u1" });
    expect(normalized({ "llm.invocation_parameters": raw })["llm.invocation_parameters"]).toBe(raw);
  });

  it.each([
    ["unparseable", "{not json"],
    ["a JSON array", "[1,2,3]"],
    ["a JSON scalar", '"just a string"'],
  ])("passes %s through untouched: the caller's value is the only record", (_label, raw) => {
    expect(normalized({ "llm.invocation_parameters": raw })["llm.invocation_parameters"]).toBe(raw);
  });

  it("leaves tool definitions in the bag, where masking already redacts them", () => {
    // Fanning unknown members out into keys of our own would move content out
    // from under that redaction and past captureContent: false. There is
    // deliberately no rius.request.<key> catch-all.
    const out = normalized({
      "llm.invocation_parameters": JSON.stringify({ model: "gpt-4o", tools: ["secret"] }),
    });
    expect(out["llm.invocation_parameters"]).toBe(JSON.stringify({ tools: ["secret"] }));
  });

  it("is idempotent across the start-then-end double pass", () => {
    const attributes: Attributes = {
      "llm.invocation_parameters": JSON.stringify({ model: "gpt-4o", custom: 1 }),
    };
    const processor = new NormalizingSpanProcessor();
    processor.onStart(startingSpan(attributes), {} as never);
    const afterStart = { ...attributes };
    processor.onEnd(endedSpan(attributes));
    expect(attributes).toEqual(afterStart);
  });
});

describe("finish reasons: verbatim, by decision", () => {
  it("wraps a scalar finish reason into a one-element array", () => {
    // The source is a scalar and the canonical key is an array, one entry per
    // generation.
    expect(normalized({ "llm.finish_reason": "stop" })).toEqual({
      "gen_ai.response.finish_reasons": ["stop"],
    });
  });

  it("passes a list-valued finish reason through as a list", () => {
    // An instrumentation that already reports one reason per choice must not
    // be double-wrapped into [["stop", "length"]].
    expect(normalized({ "llm.finish_reason": ["stop", "length"] })).toEqual({
      "gen_ai.response.finish_reasons": ["stop", "length"],
    });
  });

  /**
   * The decision this rule exists to encode.
   *
   * The registry defines the key as a free-form string array with no enum, so
   * there is no vocabulary to conform to. OpenInference's own converter
   * lowercases and folds tool_calls/function_call into tool_call; we do not,
   * because that would replace what OpenAI actually returned with a string
   * neither the provider nor the conventions use, while leaving Anthropic's
   * end_turn and tool_use untouched. Fidelity lost, nothing unified.
   *
   * If this test is ever changed to expect a folded value, the change belongs
   * in the canonical-attribute contract first ("Finish-reason values:
   * verbatim"), it has to bind the native path too, and the Python SDK has to
   * change with it.
   */
  it.each(["tool_calls", "function_call", "tool_use", "end_turn", "STOP", "max_tokens"])(
    "never rewrites the provider value %s",
    (providerValue) => {
      const out = normalized({ "llm.finish_reason": providerValue });
      expect(out["gen_ai.response.finish_reasons"]).toEqual([providerValue]);
    },
  );

  it("lets a native finish reason win, and still deletes the source", () => {
    const out = normalized({
      "llm.finish_reason": "stop",
      "gen_ai.response.finish_reasons": ["length"],
    });
    expect(out["gen_ai.response.finish_reasons"]).toEqual(["length"]);
    expect(out["llm.finish_reason"]).toBeUndefined();
  });
});

describe("taxonomy", () => {
  it("derives the operation from the kind and keeps both", () => {
    expect(normalized({ "openinference.span.kind": "LLM" })).toEqual({
      "openinference.span.kind": "LLM",
      "gen_ai.operation.name": "chat",
    });
  });

  it("derives the kind from the operation and keeps both", () => {
    expect(normalized({ "gen_ai.operation.name": "execute_tool" })).toEqual({
      "gen_ai.operation.name": "execute_tool",
      "openinference.span.kind": "TOOL",
    });
  });

  it("gives CHAIN no operation, the one kind the conventions do not cover", () => {
    expect(normalized({ "openinference.span.kind": "CHAIN" })).toEqual({
      "openinference.span.kind": "CHAIN",
    });
  });

  it.each(["invoke_workflow", "plan"])(
    "places %s on CHAIN, which only the reverse direction can do",
    (operation) => {
      expect(normalized({ "gen_ai.operation.name": operation })["openinference.span.kind"]).toBe(
        "CHAIN",
      );
    },
  );

  it("leaves a span carrying both keys completely alone", () => {
    // LLM + text_completion says something the maps cannot; re-deriving would
    // flatten it to chat.
    expect(
      normalized({ "openinference.span.kind": "LLM", "gen_ai.operation.name": "text_completion" }),
    ).toEqual({ "openinference.span.kind": "LLM", "gen_ai.operation.name": "text_completion" });
  });

  it("keeps an unrecognised kind and derives nothing from it", () => {
    // RERANKER is real: the TypeScript OpenInference taxonomy has RERANKER,
    // GUARDRAIL, EVALUATOR and PROMPT, none of which this SDK models. A kind
    // we do not know is not a reason to lose the span.
    expect(normalized({ "openinference.span.kind": "RERANKER" })).toEqual({
      "openinference.span.kind": "RERANKER",
    });
  });

  it("keeps an unrecognised operation and derives nothing from it", () => {
    expect(normalized({ "gen_ai.operation.name": "teleport" })).toEqual({
      "gen_ai.operation.name": "teleport",
    });
  });

  it("round-trips every kind that has an operation, without inverting the maps", () => {
    // Asserting the two maps are inverses would be wrong: several operations
    // share one kind, so only the entries with a canonical operation
    // round-trip.
    for (const kind of Object.values(SpanKind)) {
      const operation = operationForKind(kind);
      if (operation === undefined) continue;
      expect(kindForOperation(operation), `${kind} -> ${operation} -> ?`).toBe(kind);
    }
  });

  it("resolves nothing through the prototype chain", () => {
    expect(operationForKind("constructor")).toBeUndefined();
    expect(kindForOperation("toString")).toBeUndefined();
  });
});

describe("the first-token event", () => {
  const firstTokenAt = (time: [number, number]): TimedEvent =>
    ({ name: OPENINFERENCE_FIRST_TOKEN_EVENT, time, attributes: {} }) as TimedEvent;

  it("becomes the canonical event plus the streaming attributes", () => {
    const events = [firstTokenAt([0, 250_000_000])];
    const out = normalized({}, { events, startTime: [0, 0] });
    expect(events.map((event) => event.name)).toEqual(["gen_ai.first_token"]);
    expect(out["gen_ai.request.stream"]).toBe(true);
    // Seconds, as a float: what the native path emits and what the
    // conventions specify. 250ms, so a nanosecond or millisecond slip fails
    // loudly rather than producing a plausible number.
    expect(out["gen_ai.response.time_to_first_chunk"]).toBeCloseTo(0.25, 6);
  });

  it("keeps a canonical event already present and drops the duplicate source", () => {
    const events = [
      { name: "gen_ai.first_token", time: [0, 1], attributes: {} } as TimedEvent,
      firstTokenAt([0, 999]),
    ];
    normalized({}, { events });
    expect(events.map((event) => event.name)).toEqual(["gen_ai.first_token"]);
  });

  it("never overwrites canonical attributes the span already carries", () => {
    const out = normalized(
      { "gen_ai.request.stream": false, "gen_ai.response.time_to_first_chunk": 9 },
      { events: [firstTokenAt([0, 250_000_000])] },
    );
    expect(out["gen_ai.request.stream"]).toBe(false);
    expect(out["gen_ai.response.time_to_first_chunk"]).toBe(9);
  });

  it("preserves event order and leaves unrelated events untouched", () => {
    const events = [
      { name: "before", time: [0, 1], attributes: {} } as TimedEvent,
      firstTokenAt([0, 2]),
      { name: "after", time: [0, 3], attributes: {} } as TimedEvent,
    ];
    normalized({}, { events });
    expect(events.map((event) => event.name)).toEqual(["before", "gen_ai.first_token", "after"]);
  });

  it("gains nothing on a span with no such event", () => {
    expect(normalized({ "llm.token_count.prompt": 5 }, { events: [] })).toEqual({
      "gen_ai.usage.input_tokens": 5,
    });
  });

  /**
   * The gap, pinned so we hear about it changing.
   *
   * The Python openai instrumentation emits `add_event("First Token Stream
   * Event")`; no TypeScript instrumentation does, at the pinned peer
   * versions. The mapping is carried anyway so both SDKs' tables stay
   * identical. IF THIS TEST FAILS, upstream has ADDED the event and the rule
   * above has just gone live — good news, not a regression. Update this test
   * and check whether the event's SHAPE matches too: we rely on it carrying
   * no explicit timestamp, so the SDK stamps the moment the chunk arrived.
   */
  it("is emitted by no TypeScript instrumentation at the pinned peer versions", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const roots = [
      "node_modules/@arizeai/openinference-instrumentation-openai",
      "node_modules/@arizeai/openinference-instrumentation-anthropic",
      "node_modules/@arizeai/openinference-instrumentation-langchain",
    ];
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (entry.endsWith(".js") || entry.endsWith(".cjs") || entry.endsWith(".mjs")) {
          if (readFileSync(path, "utf8").includes(OPENINFERENCE_FIRST_TOKEN_EVENT)) hits.push(path);
        }
      }
    };
    for (const root of roots) walk(root);
    expect(hits).toEqual([]);
  });
});

describe("error.type from the exception event", () => {
  const exception = (type: string): TimedEvent =>
    ({ name: "exception", time: [0, 0], attributes: { "exception.type": type } }) as TimedEvent;

  it("is set from the event, spelled exactly as the event spells it", () => {
    const out = normalized(
      {},
      { events: [exception("RateLimitError")], status: { code: SpanStatusCode.ERROR } },
    );
    expect(out["error.type"]).toBe("RateLimitError");
  });

  it("emits nothing on an ERROR span with no exception event", () => {
    // An error with no exception is not classifiable, and guessing a value
    // would be worse than leaving it unset. Do not "helpfully" fill this in.
    const out = normalized({}, { events: [], status: { code: SpanStatusCode.ERROR } });
    expect(out["error.type"]).toBeUndefined();
    expect(out).toEqual({});
  });

  it("leaves a non-ERROR span alone even when it recorded an exception", () => {
    // An exception that was recorded and handled is not a failure.
    const out = normalized(
      {},
      { events: [exception("ValueError")], status: { code: SpanStatusCode.OK } },
    );
    expect(out["error.type"]).toBeUndefined();
  });

  it("never overwrites an error.type the producer already set", () => {
    const out = normalized(
      { "error.type": "tool_error" },
      { events: [exception("ValueError")], status: { code: SpanStatusCode.ERROR } },
    );
    expect(out["error.type"]).toBe("tool_error");
  });
});

describe("the spans this SDK emits itself", () => {
  let client: RiusClient | undefined;
  let exporter: InMemorySpanExporter;

  afterEach(async () => {
    await client?.shutdown().catch(() => {});
    client = undefined;
  });

  /** One native span, all the way through init()'s real processor chain. */
  async function nativeSpan(): Promise<Attributes> {
    exporter = new InMemorySpanExporter();
    client = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
    await client.ready;
    startSpan("chat gpt-4o", { kind: SpanKind.LLM }).end();
    await client.flush();
    return exporter.getFinishedSpans()[0].attributes;
  }

  /**
   * The bug this whole rule shape exists to prevent, asserted end to end
   * rather than only at the table level so a refactor of the processor cannot
   * reintroduce it.
   *
   * Every span this SDK emits carries openinference.span.kind, so the taxonomy
   * rules match all of them. A plain mapping rule DELETES its source, which
   * would strip the taxonomy key from every native span — data loss, not a
   * normalization quirk. The expanding rule returns its own source, which is
   * the single exemption from the generic delete.
   */
  // Explicit timeouts: these two stand up a real init() pipeline, which
  // lazily loads whatever optional instrumentation packages are installed.
  // On an idle machine that is well under a second, but the suite runs one
  // worker per core and under contention it is not, and vitest's 5s default
  // is a wall-clock bet rather than a correctness bound.
  it("keep their openinference.span.kind", async () => {
    expect((await nativeSpan())["openinference.span.kind"]).toBe("LLM");
  }, 30_000);

  it("are otherwise unchanged: the rules re-derive exactly what is there", async () => {
    const attributes = await nativeSpan();
    expect(attributes["gen_ai.operation.name"]).toBe("chat");
    // No canonical key the SDK did not set, and no dialect key invented.
    expect(Object.keys(attributes).filter((key) => key.startsWith("llm."))).toEqual([]);
  }, 30_000);
});

describe("the table's reach", () => {
  it("claims the gen_ai. namespace, so our own spans no longer take the fast path", () => {
    // gen_ai.operation.name and gen_ai.system are sources, so every span we
    // emit walks the rules. They match, re-derive what is already present,
    // and write nothing — the cost is the walk, not a rebuild. There is no
    // no-op equality check to port: nothing is rebuilt in a mutate-in-place
    // design, so there would be nothing for it to avoid.
    const sources = NORMALIZATION_RULES.flatMap((rule) =>
      typeof rule.source === "string" ? [rule.source] : rule.source,
    );
    expect(sources.some((source) => source.startsWith("gen_ai."))).toBe(true);
  });
});
