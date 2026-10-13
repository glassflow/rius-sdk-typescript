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
      // Kept, and only a fallback for the provider: for Azure OpenAI the two
      // differ (provider = azure, system = openai).
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
      vertexai: "gcp.vertex_ai",
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

  /**
   * An OpenAI client pointed at a gateway (Vercel AI Gateway, OpenRouter, a
   * LiteLLM proxy) gets no llm.provider: the instrumentation sets it only for
   * hosts it recognizes. llm.system names the API the client speaks, which is
   * what the registry asks of the provider: the instrumentation's best
   * knowledge, a discriminator for the telemetry flavor, allowed to differ
   * from whoever served the request behind a proxy.
   */
  it.each([
    ["openai", "openai"],
    ["anthropic", "anthropic"],
    ["cohere", "cohere"],
    ["mistralai", "mistral_ai"],
    ["vertexai", "gcp.vertex_ai"],
  ])("falls back to llm.system %s when the host is unknown, and keeps it", (source, expected) => {
    expect(normalized({ "llm.system": source })).toEqual({
      "llm.system": source,
      "gen_ai.provider.name": expected,
    });
  });

  it("prefers llm.provider over llm.system, keeping the system (Azure OpenAI)", () => {
    expect(normalized({ "llm.provider": "azure", "llm.system": "openai" })).toEqual({
      "llm.system": "openai",
      "gen_ai.provider.name": "azure",
    });
  });

  it("prefers the deprecated gen_ai.system over llm.system", () => {
    expect(normalized({ "gen_ai.system": "az.ai.openai", "llm.system": "openai" })).toEqual({
      "llm.system": "openai",
      "gen_ai.provider.name": "azure.ai.openai",
    });
  });

  it("lets a native provider win over llm.system", () => {
    expect(normalized({ "gen_ai.provider.name": "groq", "llm.system": "openai" })).toEqual({
      "gen_ai.provider.name": "groq",
      "llm.system": "openai",
    });
  });

  it("names the provider at start, so a still-running gateway call is classifiable", () => {
    const attributes: Attributes = { "llm.system": "openai" };
    new NormalizingSpanProcessor().onStart(startingSpan(attributes), {} as never);
    expect(attributes["gen_ai.provider.name"]).toBe("openai");
  });
});

describe("a routed model name", () => {
  const routed = (provider: string, model: string): Attributes => ({
    "llm.provider": provider,
    "llm.invocation_parameters": JSON.stringify({ model }),
  });

  it.each([
    // LiteLLM records the model as routed: the prefix is the provider.
    ["openai", "openai/gpt-4o-mini", "gpt-4o-mini"],
    ["anthropic", "anthropic/claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001"],
    // compared under the registry's spelling
    ["vertex_ai", "vertex_ai/gemini-2.5-flash", "gemini-2.5-flash"],
    // a prefix naming anyone else is part of the name
    ["openai", "openai/google/gemini-2.5-flash", "google/gemini-2.5-flash"],
    ["openai", "google/gemini-2.5-flash", "google/gemini-2.5-flash"],
    ["anthropic", "openai/gpt-4o-mini", "openai/gpt-4o-mini"],
    // nothing after the slash, or no slash
    ["openai", "openai/", "openai/"],
    ["openai", "gpt-4o-mini", "gpt-4o-mini"],
  ])("with provider %s turns %s into %s", (provider, model, expected) => {
    expect(normalized(routed(provider, model))["gen_ai.request.model"]).toBe(expected);
  });

  it("keeps its prefix without a provider", () => {
    const attributes = {
      "llm.invocation_parameters": JSON.stringify({ model: "openai/gpt-4o-mini" }),
    };
    expect(normalized(attributes)["gen_ai.request.model"]).toBe("openai/gpt-4o-mini");
  });

  it("is stripped against a native provider", () => {
    const attributes = {
      "gen_ai.provider.name": "openai",
      "llm.invocation_parameters": JSON.stringify({ model: "openai/gpt-4o-mini" }),
    };
    expect(normalized(attributes)["gen_ai.request.model"]).toBe("gpt-4o-mini");
  });

  it("is never stripped when the producer set it natively", () => {
    expect(
      normalized({
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "openai/gpt-4o-mini",
      }),
    ).toEqual({ "gen_ai.provider.name": "openai", "gen_ai.request.model": "openai/gpt-4o-mini" });
  });

  it("is already bare at start, since by onEnd the model counts as native", () => {
    const attributes = routed("openai", "openai/gpt-4o-mini");
    new NormalizingSpanProcessor().onStart(startingSpan(attributes), {} as never);
    expect(attributes["gen_ai.request.model"]).toBe("gpt-4o-mini");
    new NormalizingSpanProcessor().onEnd(endedSpan(attributes));
    expect(attributes["gen_ai.request.model"]).toBe("gpt-4o-mini");
  });
});

describe("the invocation-parameter bag", () => {
  it("promotes the spec members in the documented order, with their targets", () => {
    expect(INVOCATION_PARAMETER_MEMBERS.map(([member, target]) => [member, target])).toEqual([
      ["model", "gen_ai.request.model"],
      ["model_name", "gen_ai.request.model"],
      ["temperature", "gen_ai.request.temperature"],
      ["top_p", "gen_ai.request.top_p"],
      ["top_k", "gen_ai.request.top_k"],
      ["max_tokens", "gen_ai.request.max_tokens"],
      ["max_completion_tokens", "gen_ai.request.max_tokens"],
      ["num_output", "gen_ai.request.max_tokens"],
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

  it("reads the model and max tokens from LlamaIndex's model metadata", () => {
    // LlamaIndex fills the bag with the model's metadata, not the request's
    // parameters; the rest of the metadata stays in the bag.
    const out = normalized({
      "llm.invocation_parameters": JSON.stringify({
        context_window: 128000,
        num_output: 64,
        is_chat_model: true,
        model_name: "gpt-4o-mini",
        system_role: "system",
      }),
    });
    expect(out["gen_ai.request.model"]).toBe("gpt-4o-mini");
    expect(out["gen_ai.request.max_tokens"]).toBe(64);
    expect(JSON.parse(out["llm.invocation_parameters"] as string)).toEqual({
      context_window: 128000,
      is_chat_model: true,
      system_role: "system",
    });
  });

  it("reads LlamaIndex's num_output -1 as no budget", () => {
    const out = normalized({
      "llm.invocation_parameters": JSON.stringify({ num_output: -1, model_name: "gpt-4o-mini" }),
    });
    expect(out["gen_ai.request.max_tokens"]).toBeUndefined();
    expect(JSON.parse(out["llm.invocation_parameters"] as string)).toEqual({ num_output: -1 });
  });

  it("keeps model over a different model_name, which stays in the bag", () => {
    const out = normalized({
      "llm.invocation_parameters": JSON.stringify({ model: "gpt-4o", model_name: "gpt-4o-x" }),
    });
    expect(out["gen_ai.request.model"]).toBe("gpt-4o");
    expect(JSON.parse(out["llm.invocation_parameters"] as string)).toEqual({
      model_name: "gpt-4o-x",
    });
  });

  it("drops a second spelling that repeats the promoted value", () => {
    // LangChain's bag has model_name next to model, with the same value.
    const out = normalized({
      "llm.invocation_parameters": JSON.stringify({
        model: "gpt-4o",
        model_name: "gpt-4o",
        _type: "openai-chat",
      }),
    });
    expect(out["gen_ai.request.model"]).toBe("gpt-4o");
    expect(JSON.parse(out["llm.invocation_parameters"] as string)).toEqual({
      _type: "openai-chat",
    });
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
    const raw = JSON.stringify({ user: "u1", response_format: { type: "json_object" } });
    expect(normalized({ "llm.invocation_parameters": raw })["llm.invocation_parameters"]).toBe(raw);
  });

  it.each([
    ["unparseable", "{not json"],
    ["a JSON array", "[1,2,3]"],
    ["a JSON scalar", '"just a string"'],
  ])("passes %s through untouched: the caller's value is the only record", (_label, raw) => {
    expect(normalized({ "llm.invocation_parameters": raw })["llm.invocation_parameters"]).toBe(raw);
  });

  it("moves tool definitions onto gen_ai.tool.definitions, never into a key of our own", () => {
    // Fanning unknown members out into keys of our own would move content out
    // from under masking and past captureContent: false, so there is
    // deliberately no rius.request.<key> catch-all. Tool definitions have a
    // canonical CONTENT key, and the reassembly pass puts them there.
    const out = normalized({
      "llm.invocation_parameters": JSON.stringify({ model: "gpt-4o", tools: ["secret"] }),
    });
    expect(out).toEqual({
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.tool.definitions": JSON.stringify(["secret"]),
    });
  });

  // LangChain serializes the MODEL object's settings into the bag, so `stream`
  // is the model's default, not what the call did: ChatOpenAI.stream() records
  // "stream": false (rius-semconv recordings, scenario chat_stream). It is
  // never promoted, and stays in the bag.
  it("never takes a Python LangChain bag's stream member (marked by _type)", () => {
    const out = normalized({
      "llm.invocation_parameters": JSON.stringify({
        model: "gpt-4o-mini",
        stream: false,
        _type: "openai-chat",
      }),
    });
    expect(out["gen_ai.request.model"]).toBe("gpt-4o-mini");
    expect(out["gen_ai.request.stream"]).toBeUndefined();
    expect(JSON.parse(out["llm.invocation_parameters"] as string)).toEqual({
      stream: false,
      _type: "openai-chat",
    });
  });

  it("never takes a JS LangChain bag's stream member (known by its ls_* run metadata)", () => {
    const metadata = JSON.stringify({
      ls_provider: "openai",
      ls_integration: "langchain_chat_model",
    });
    const out = normalized({
      metadata,
      "llm.invocation_parameters": JSON.stringify({ model: "gpt-4o-mini", stream: false }),
    });
    expect(out["gen_ai.request.model"]).toBe("gpt-4o-mini");
    expect(out["gen_ai.request.stream"]).toBeUndefined();
    expect(JSON.parse(out["llm.invocation_parameters"] as string)).toEqual({ stream: false });
    // Read, not consumed.
    expect(out.metadata).toBe(metadata);
  });

  // The JS LangChain instrumentation records no provider key at all; its run
  // metadata names it (ls_provider), through llm.provider's spellings.
  it.each([
    ["openai", "openai"],
    ["anthropic", "anthropic"],
    ["mistralai", "mistral_ai"],
    ["google_vertexai", "google_vertexai"],
  ])("names a LangChain run's provider from ls_provider %s", (lsProvider, expected) => {
    const metadata = JSON.stringify({ ls_provider: lsProvider, ls_model_type: "chat" });
    const out = normalized({
      metadata,
      "llm.invocation_parameters": JSON.stringify({ model: "gpt-4o-mini", stream: false }),
    });
    expect(out["gen_ai.provider.name"]).toBe(expected);
    expect(out.metadata).toBe(metadata);
  });

  it("names the provider even when the bag promotes nothing", () => {
    const bag = JSON.stringify({ _type: "openai-chat", stop: null });
    const metadata = JSON.stringify({ ls_provider: "openai" });
    expect(normalized({ metadata, "llm.invocation_parameters": bag })).toEqual({
      metadata,
      "llm.invocation_parameters": bag,
      "gen_ai.provider.name": "openai",
    });
  });

  it.each([
    [{ "llm.provider": "azure" }, "azure"],
    [{ "llm.system": "anthropic" }, "anthropic"],
    [{ "gen_ai.provider.name": "groq" }, "groq"],
  ])("lets any provider key win over ls_provider (%o)", (other, expected) => {
    const out = normalized({
      ...other,
      metadata: JSON.stringify({ ls_provider: "openai", ls_model_type: "chat" }),
      "llm.invocation_parameters": JSON.stringify({ model: "gpt-4o-mini" }),
    });
    expect(out["gen_ai.provider.name"]).toBe(expected);
  });

  it.each([
    JSON.stringify({ tenant: "acme" }),
    JSON.stringify({ ls_provider: "", ls_model_type: "chat" }),
    JSON.stringify({ ls_provider: 7, ls_model_type: "chat" }),
    "not json",
  ])("names no provider without a named ls_provider (%s)", (metadata) => {
    const out = normalized({
      metadata,
      "llm.invocation_parameters": JSON.stringify({ model: "gpt-4o-mini" }),
    });
    expect(out["gen_ai.provider.name"]).toBeUndefined();
    expect(out.metadata).toBe(metadata);
  });

  it("still takes stream from a bag that records the request body", () => {
    const out = normalized({
      metadata: JSON.stringify({ tenant: "acme" }),
      "llm.invocation_parameters": JSON.stringify({ model: "gpt-4o-mini", stream: true }),
    });
    expect(out["gen_ai.request.stream"]).toBe(true);
    expect(out["llm.invocation_parameters"]).toBeUndefined();
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

  it.each(["invoke_workflow", "plan", "agent_step"])(
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
    // GUARDRAIL is real: the TypeScript OpenInference taxonomy has GUARDRAIL,
    // EVALUATOR and PROMPT, none of which this SDK models. A kind we do not
    // know is not a reason to lose the span.
    expect(normalized({ "openinference.span.kind": "GUARDRAIL" })).toEqual({
      "openinference.span.kind": "GUARDRAIL",
    });
  });

  it("derives the rerank operation from an OpenInference RERANKER span", () => {
    expect(normalized({ "openinference.span.kind": "RERANKER" })).toEqual({
      "openinference.span.kind": "RERANKER",
      "gen_ai.operation.name": "rerank",
    });
  });

  it("derives RERANKER from the AI SDK's rerank operation", () => {
    expect(normalized({ "gen_ai.operation.name": "rerank" })).toEqual({
      "gen_ai.operation.name": "rerank",
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

/**
 * The metric spelling: a measured duration with no first-token event.
 *
 * @ai-sdk/otel and pydantic-ai write the conventions' METRIC name onto the chat
 * span, in seconds, and record no event. The backend reads time to first chunk
 * from the event alone, so onEnd both maps the attribute and places the event
 * the span is missing.
 */
describe("time to first chunk under its metric name", () => {
  const METRIC = "gen_ai.client.operation.time_to_first_chunk";
  const start: [number, number] = [1_700_000_000, 0];

  function ended(attributes: Attributes, events: TimedEvent[] = [], end?: [number, number]) {
    const span = endedSpan(attributes, { events, startTime: start });
    if (end !== undefined) (span as unknown as { endTime: [number, number] }).endTime = end;
    new NormalizingSpanProcessor().onEnd(span);
    return { attributes, events: span.events.map((event) => [event.name, event.time]) };
  }

  it("becomes the canonical attribute, the stream flag and a first-token event", () => {
    const out = ended({ [METRIC]: 1.5 });
    expect(out.attributes[METRIC]).toBeUndefined();
    expect(out.attributes["gen_ai.response.time_to_first_chunk"]).toBe(1.5);
    expect(out.attributes["gen_ai.request.stream"]).toBe(true);
    expect(out.events).toEqual([["gen_ai.first_token", [1_700_000_001, 500_000_000]]]);
  });

  it("gives a canonical duration alone its event too", () => {
    const out = ended({ "gen_ai.response.time_to_first_chunk": 1.5 });
    expect(out.events).toEqual([["gen_ai.first_token", [1_700_000_001, 500_000_000]]]);
  });

  it("never duplicates a first-token event the span already has", () => {
    const event = { name: "gen_ai.first_token", time: [1_700_000_000, 7] } as TimedEvent;
    expect(ended({ [METRIC]: 0.2 }, [event]).events).toEqual([
      ["gen_ai.first_token", [1_700_000_000, 7]],
    ]);
  });

  it("lets native values win over the metric spelling", () => {
    const out = ended({
      [METRIC]: 9,
      "gen_ai.response.time_to_first_chunk": 1.5,
      "gen_ai.request.stream": false,
    });
    expect(out.attributes["gen_ai.response.time_to_first_chunk"]).toBe(1.5);
    expect(out.attributes["gen_ai.request.stream"]).toBe(false);
    expect(out.attributes[METRIC]).toBeUndefined();
  });

  it("never places the event after the span ends", () => {
    const out = ended({ [METRIC]: 5 }, [], [1_700_000_000, 1_000_000]);
    expect(out.events).toEqual([["gen_ai.first_token", [1_700_000_000, 1_000_000]]]);
  });

  it.each([-1, "1.5", true])("drops an unusable duration (%s) without an event", (value) => {
    const out = ended({ [METRIC]: value as AttributeValue });
    expect(out.attributes["gen_ai.response.time_to_first_chunk"]).toBeUndefined();
    expect(out.attributes["gen_ai.request.stream"]).toBeUndefined();
    expect(out.events).toEqual([]);
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
