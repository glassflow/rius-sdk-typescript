import { describe, expect, it } from "vitest";
import * as semconv from "../src/semconv.js";
import { SpanKind, kindAttributes } from "../src/semconv.js";
import fixture from "./fixtures/semconv.json" with { type: "json" };

describe("semconv", () => {
  it("uses the wire-visible tracer name the backend keys on", () => {
    expect(semconv.TRACER_NAME).toBe("glassflow");
  });

  it("matches every Python constant verbatim", () => {
    // Constants Python has that this SDK deliberately does not implement.
    // Declared explicitly: a NEW unported constant must fail here so a human
    // decides whether to port it, rather than being skipped silently.
    const PYTHON_ONLY = new Set(["GLASSFLOW_SPAN_PENDING"]);

    for (const [name, value] of Object.entries(fixture as Record<string, string>)) {
      const ours = (semconv as Record<string, unknown>)[name];
      if (ours === undefined) {
        expect(
          PYTHON_ONLY.has(name),
          `${name} exists in Python but not here, and is not declared in PYTHON_ONLY`,
        ).toBe(true);
        continue;
      }
      expect(ours, `${name} drifted from Python`).toBe(value);
    }
  });

  it("maps LLM spans to the chat operation", () => {
    expect(kindAttributes(SpanKind.LLM)).toEqual({
      "openinference.span.kind": "LLM",
      "gen_ai.operation.name": "chat",
    });
  });

  it("emits no operation name for kinds without a canonical one", () => {
    expect(kindAttributes(SpanKind.CHAIN)).toEqual({
      "openinference.span.kind": "CHAIN",
    });
  });

  it("treats unflattened llm.prompts and llm.prompt_template as content", () => {
    expect(semconv.CONTENT_ATTRIBUTES.has("llm.prompts")).toBe(true);
    expect(semconv.CONTENT_ATTRIBUTES.has("llm.prompt_template")).toBe(true);
  });

  it("has a bare CONTENT_ATTRIBUTES entry for every CONTENT_ATTRIBUTE_PREFIXES family", () => {
    for (const prefix of semconv.CONTENT_ATTRIBUTE_PREFIXES) {
      const bareKey = prefix.slice(0, -1); // drop the trailing "."
      expect(
        semconv.CONTENT_ATTRIBUTES.has(bareKey),
        `prefix "${prefix}" has no matching bare key "${bareKey}" in CONTENT_ATTRIBUTES, so an instrumentation emitting one unflattened attribute would leak past captureContent: false`,
      ).toBe(true);
    }
  });
});
