import { type Attributes, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGeneration } from "../src/generation.js";
import {
  INVOCATION_PARAMETER_MEMBERS,
  REQUEST_PARAMETER_GUARDS,
  invocationParameters,
} from "../src/normalize.js";
import {
  GEN_AI_REQUEST_PARAMETERS,
  GEN_AI_REQUEST_PREFIX,
  requestAttributeKey,
} from "../src/semconv.js";

/**
 * One parameter, one shape: the native `modelParameters` path and the
 * `llm.invocation_parameters` rule must agree on every canonical request key.
 *
 * Both paths route a canonical `gen_ai.request.*` key through the same guard,
 * and both resolve two spellings of one parameter by the same precedence. A
 * value that fails its key's guard was still sent to the model, so it lands
 * under `rius.request.<spelling>` unchanged rather than being dropped.
 *
 * Built on a bare TracerProvider, so what is asserted is the span as the
 * generation wrote it, with no normalizer in between.
 */

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});
afterEach(async () => {
  trace.disable();
  await provider.shutdown();
});

function params(parameters: Record<string, unknown>): Attributes {
  exporter.reset();
  startGeneration("chat", { modelParameters: parameters }).end();
  return exporter.getFinishedSpans()[0].attributes;
}

describe("canonical request keys carry only the shape they define", () => {
  it("wraps a lone stop string into a list", () => {
    // gen_ai.request.stop_sequences is a string array; OpenAI accepts a lone
    // string for `stop`, and it means the one-element list.
    const attributes = params({ stop: "END" });
    expect(attributes["gen_ai.request.stop_sequences"]).toEqual(["END"]);
    expect(attributes["rius.request.stop"]).toBeUndefined();
  });

  it("wraps a lone encoding_format into a list", () => {
    expect(params({ encoding_format: "float" })["gen_ai.request.encoding_formats"]).toEqual([
      "float",
    ]);
  });

  it("passes a string list on an array key through", () => {
    const attributes = params({ stop: ["a", "b"], embedding_types: ["float", "int8"] });
    expect(attributes["gen_ai.request.stop_sequences"]).toEqual(["a", "b"]);
    expect(attributes["gen_ai.request.encoding_formats"]).toEqual(["float", "int8"]);
  });

  it.each([
    // numbers: a numeric string is not a number, and bool is not either
    ["temperature", "0.2", "0.2"],
    ["top_p", true, true],
    ["frequency_penalty", [0.1], [0.1]],
    ["presencePenalty", "high", "high"],
    // counts: an object is JSON-encoded under OUR key, not the numeric one
    ["max_tokens", { limit: 5 }, '{"limit":5}'],
    ["top_k", "40", "40"],
    ["seed", false, false],
    ["n", "2", "2"],
    // text: the empty string is not a value, nor is a number
    ["model", "", ""],
    ["model", 4, 4],
    ["reasoning_effort", 3, 3],
    ["previous_response_id", ["r1"], ["r1"]],
    ["starting_after", 9, 9],
    // string arrays: a list of non-strings is not a string array
    ["stop", [["a"], ["b"]], '[["a"],["b"]]'],
    ["stop_sequences", [1, 2], [1, 2]],
    ["encoding_format", 7, 7],
    // flag
    ["stream", "yes", "yes"],
    ["stream", 1, 1],
  ] as const)(
    "puts %s=%j under rius.request when it fails the key's guard",
    (spelling, value, recorded) => {
      const attributes = params({ [spelling]: value });
      expect(attributes[requestAttributeKey(spelling)]).toBeUndefined();
      expect(attributes[`rius.request.${spelling}`]).toEqual(recorded);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("does not treat %s as a number", (value) => {
    // Not a value a model is sent; the Python SDK's guard rejects it too.
    const attributes = params({ temperature: value, max_tokens: value });
    expect(attributes["gen_ai.request.temperature"]).toBeUndefined();
    expect(attributes["gen_ai.request.max_tokens"]).toBeUndefined();
    expect(attributes["rius.request.temperature"]).toEqual(value);
  });

  it("records a count as an integer, as the normalizer does", () => {
    expect(params({ max_tokens: 256.9 })["gen_ai.request.max_tokens"]).toBe(256);
  });
});

describe("two spellings of one parameter: the first one wins", () => {
  it("keeps the first spelling and records the other under rius.request", () => {
    // First in the spelling table's precedence, as in every rule of the
    // normalizer's table. The losing spelling is still a parameter the caller
    // sent, so it is kept under our own namespace rather than dropped.
    const attributes = params({ max_tokens: 100, max_completion_tokens: 200 });
    expect(attributes["gen_ai.request.max_tokens"]).toBe(100);
    expect(attributes["rius.request.max_completion_tokens"]).toBe(200);
  });

  it("does not depend on the caller's key order", () => {
    const attributes = params({ max_output_tokens: 300, max_completion_tokens: 200, maxTokens: 1 });
    expect(attributes["gen_ai.request.max_tokens"]).toBe(1);
    expect(attributes["rius.request.max_completion_tokens"]).toBe(200);
    expect(attributes["rius.request.max_output_tokens"]).toBe(300);
  });

  it("leaves the key to the next spelling when the first fails its guard", () => {
    // "First to PRODUCE a value", as the invocation-parameters rule says.
    const attributes = params({ max_tokens: "100", max_output_tokens: 200 });
    expect(attributes["gen_ai.request.max_tokens"]).toBe(200);
    expect(attributes["rius.request.max_tokens"]).toBe("100");
  });
});

describe("the native path and the invocation-parameters rule share one table", () => {
  it("has a guard for every canonical request key", () => {
    expect(new Set(Object.keys(REQUEST_PARAMETER_GUARDS))).toEqual(
      new Set(Object.values(GEN_AI_REQUEST_PARAMETERS)),
    );
  });

  it("uses the same guard in the invocation-parameters rule", () => {
    // Only canonical targets have a native counterpart; a member promoted to
    // rius.request.* (tool_choice) has no gen_ai.request.* key to agree with.
    const canonical = INVOCATION_PARAMETER_MEMBERS.filter(([, target]) =>
      target.startsWith(GEN_AI_REQUEST_PREFIX),
    );
    expect(canonical.length).toBeGreaterThan(0);
    for (const [member, target, convert] of canonical) {
      expect(convert, member).toBe(REQUEST_PARAMETER_GUARDS[target]);
    }
  });

  it("orders two spellings of one key the same way in both tables", () => {
    const native = Object.keys(GEN_AI_REQUEST_PARAMETERS);
    INVOCATION_PARAMETER_MEMBERS.forEach(([first, target], i) => {
      for (const [second, other] of INVOCATION_PARAMETER_MEMBERS.slice(i + 1)) {
        if (other === target) {
          expect(native.indexOf(first), `${first} before ${second}`).toBeLessThan(
            native.indexOf(second),
          );
        }
      }
    });
  });

  function canonical(attributes: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(attributes).filter(([key]) => key.startsWith(GEN_AI_REQUEST_PREFIX)),
    );
  }

  it.each([
    { stop: "END" },
    { stop: ["a", "b"] },
    { stop: [["a"]] },
    { temperature: "0.2" },
    { temperature: 1 },
    { temperature: true },
    { max_tokens: { limit: 5 } },
    { max_tokens: 256.5 },
    { seed: "7" },
    { n: 2 },
    { model: "" },
    { model: "gpt-4o" },
    { stream: "yes" },
    { stream: false },
    { max_tokens: 100, max_completion_tokens: 200 },
    { max_completion_tokens: 200, max_tokens: 100 },
    { max_tokens: "100", max_completion_tokens: 200 },
    { stop: "A", stop_sequences: ["B"] },
    { stop_sequences: ["B"], stop: "A" },
    { stop: 3, stop_sequences: ["B"] },
  ])("puts the same canonical keys on the wire either way: %j", (bag) => {
    const native = canonical(params(bag));
    const normalized = canonical(invocationParameters(JSON.stringify(bag)));
    expect(native).toEqual(normalized);
  });
});
