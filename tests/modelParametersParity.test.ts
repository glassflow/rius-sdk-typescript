import type { Attributes } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { startGeneration } from "../src/generation.js";
import { GEN_AI_REQUEST_PREFIX, RIUS_REQUEST_PREFIX } from "../src/semconv.js";
import expected from "./fixtures/model_parameters_expected.json" with { type: "json" };
import input from "./fixtures/model_parameters_input.json" with { type: "json" };

/**
 * Cross-SDK parity for `modelParameters`: the same input must put the same
 * request attributes on the wire whichever SDK recorded it.
 *
 * The EXPECTED file is the Python SDK's output, not ours — it is written by
 * `scripts/gen-model-parameters-fixture.py` running the Python SDK's own
 * function over the input file. So a failure here means the two SDKs
 * disagree, and the Python side is the reference.
 *
 * Every value is compared byte for byte, with ONE declared exception: a case
 * lists the keys whose value is JSON-ENCODED (a nested object, a
 * heterogeneous list), and those are compared as parsed JSON. The two SDKs'
 * JSON encoders differ in whitespace (Python writes `", "` and `": "`), which
 * is true of every JSON-encoded attribute either SDK emits and is not
 * something this mapping introduced. What the exception still asserts is the
 * part that matters here: the same key, a string rather than a dropped value,
 * and the same content.
 */

interface Case {
  name: string;
  model_parameters: Record<string, unknown>;
  json_encoded?: string[];
}

const expectedByName = expected as Record<string, Record<string, unknown>>;

let exporter: InMemorySpanExporter;
let client: RiusClient;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  client = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
});
afterEach(async () => {
  await client.shutdown();
});

/** The request attributes a generation opened with only these parameters carries. */
async function requestAttributes(parameters: Record<string, unknown>): Promise<Attributes> {
  exporter.reset();
  startGeneration("chat", { modelParameters: parameters }).end();
  await client.flush();
  const attributes = exporter.getFinishedSpans()[0].attributes;
  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([key]) => key.startsWith(GEN_AI_REQUEST_PREFIX) || key.startsWith(RIUS_REQUEST_PREFIX),
    ),
  );
}

describe("modelParameters parity fixture", () => {
  it("covers every case the input declares", () => {
    expect(Object.keys(expectedByName).sort()).toEqual(
      (input.cases as Case[]).map((c) => c.name).sort(),
    );
  });

  it.each((input.cases as Case[]).map((c) => [c.name, c] as const))(
    "%s: matches the Python SDK",
    async (_name, testCase) => {
      const actual = await requestAttributes(testCase.model_parameters);
      const want = expectedByName[testCase.name];
      expect(Object.keys(actual).sort()).toEqual(Object.keys(want).sort());
      const encoded = new Set(testCase.json_encoded ?? []);
      for (const [key, value] of Object.entries(want)) {
        if (encoded.has(key)) {
          expect(typeof actual[key], `${key} is JSON-encoded, not dropped`).toBe("string");
          expect(JSON.parse(actual[key] as string), key).toEqual(JSON.parse(value as string));
        } else {
          expect(actual[key], key).toEqual(value);
        }
      }
    },
  );
});
