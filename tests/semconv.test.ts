import { SpanKind as OtelSpanKind } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import * as semconv from "../src/semconv.js";
import { SpanKind, kindAttributes, otelSpanKind } from "../src/semconv.js";
import fixture from "./fixtures/semconv.json" with { type: "json" };

describe("semconv", () => {
  it("uses the wire-visible tracer name the backend keys on", () => {
    expect(semconv.TRACER_NAME).toBe("rius");
  });

  it("matches every Python constant verbatim", () => {
    // Constants Python has that this SDK deliberately does not implement.
    // Declared explicitly: a NEW unported constant must fail here so a human
    // decides whether to port it, rather than being skipped silently.
    const PYTHON_ONLY = new Set<string>();

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

  it("maps RETRIEVER spans to the retrieval operation", () => {
    expect(kindAttributes(SpanKind.RETRIEVER)).toEqual({
      "openinference.span.kind": "RETRIEVER",
      "gen_ai.operation.name": "retrieval",
    });
  });

  it("emits no operation name for CHAIN, the one kind the conventions do not cover", () => {
    expect(kindAttributes(SpanKind.CHAIN)).toEqual({
      "openinference.span.kind": "CHAIN",
    });
  });

  it("gives every kind but CHAIN an operation name", () => {
    for (const kind of Object.values(SpanKind)) {
      const operation = kindAttributes(kind)["gen_ai.operation.name"];
      if (kind === SpanKind.CHAIN) expect(operation).toBeUndefined();
      else expect(operation, `${kind} has no operation name`).toBeDefined();
    }
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

  it("only allows known identity constants onto a pending snapshot", () => {
    // Every member must be one of these exact constants (not just any string),
    // so a future rename of the underlying constant can't silently desync the
    // allowlist from the value it's supposed to track.
    const knownIdentityConstants = new Set([
      semconv.OPENINFERENCE_SPAN_KIND,
      semconv.GEN_AI_OPERATION_NAME,
      semconv.GEN_AI_PROVIDER_NAME,
      semconv.GEN_AI_TOOL_NAME,
      semconv.GEN_AI_DATA_SOURCE_ID,
      semconv.GEN_AI_RETRIEVAL_TOP_K,
      semconv.GEN_AI_AGENT_NAME,
      semconv.GEN_AI_AGENT_ID,
      semconv.MCP_METHOD_NAME,
      semconv.MCP_PROTOCOL_VERSION,
      semconv.SESSION_ID,
      semconv.USER_ID,
      semconv.WORKSPACE_ROUTE,
    ]);
    expect(semconv.PENDING_IDENTITY_ATTRIBUTES.size).toBe(knownIdentityConstants.size);
    for (const attribute of semconv.PENDING_IDENTITY_ATTRIBUTES) {
      expect(knownIdentityConstants.has(attribute)).toBe(true);
    }
  });

  it("only allows the gen_ai.request. prefix onto a pending snapshot", () => {
    expect(semconv.PENDING_IDENTITY_PREFIXES).toEqual([semconv.GEN_AI_REQUEST_PREFIX]);
    for (const prefix of semconv.PENDING_IDENTITY_PREFIXES) {
      expect(prefix.endsWith(".")).toBe(true);
    }
  });
});

describe("otelSpanKind", () => {
  it("follows the GenAI conventions: remote calls CLIENT, in-process work INTERNAL", () => {
    expect(otelSpanKind(SpanKind.LLM)).toBe(OtelSpanKind.CLIENT);
    expect(otelSpanKind(SpanKind.EMBEDDING)).toBe(OtelSpanKind.CLIENT);
    expect(otelSpanKind(SpanKind.RETRIEVER)).toBe(OtelSpanKind.CLIENT);
    expect(otelSpanKind(SpanKind.TOOL)).toBe(OtelSpanKind.INTERNAL);
    expect(otelSpanKind(SpanKind.AGENT)).toBe(OtelSpanKind.INTERNAL);
    expect(otelSpanKind(SpanKind.CHAIN)).toBe(OtelSpanKind.INTERNAL);
  });

  it("covers every taxonomy kind", () => {
    for (const kind of Object.values(SpanKind)) {
      expect(otelSpanKind(kind), `${kind} has no OTel kind`).toBeDefined();
    }
  });
});

describe("rius.context.sizes", () => {
  it("is the Rius vendor key for context part sizes", () => {
    expect(semconv.RIUS_CONTEXT_SIZES).toBe("rius.context.sizes");
  });

  it("is not content: it must survive masking and captureContent: false", () => {
    expect(semconv.CONTENT_ATTRIBUTES.has(semconv.RIUS_CONTEXT_SIZES)).toBe(false);
  });

  it("is not pending identity: content sizes are unknown at span start", () => {
    expect(semconv.PENDING_IDENTITY_ATTRIBUTES.has(semconv.RIUS_CONTEXT_SIZES)).toBe(false);
  });
});

describe("retrieval attribute categories", () => {
  it("puts top_k on the pending allowlist and documents on neither list", async () => {
    const semconv = await import("../src/semconv.js");
    // The request half is knowable at span start.
    expect(semconv.PENDING_IDENTITY_ATTRIBUTES.has(semconv.GEN_AI_RETRIEVAL_TOP_K)).toBe(true);
    expect(semconv.CONTENT_ATTRIBUTES.has(semconv.GEN_AI_RETRIEVAL_TOP_K)).toBe(false);
    // The result half is not, so it never rides a snapshot. It is not content
    // either: the conventions define the entries as ids and scores rather than
    // document text, so it must survive captureContent: false.
    expect(semconv.PENDING_IDENTITY_ATTRIBUTES.has(semconv.GEN_AI_RETRIEVAL_DOCUMENTS)).toBe(false);
    expect(semconv.CONTENT_ATTRIBUTES.has(semconv.GEN_AI_RETRIEVAL_DOCUMENTS)).toBe(false);
  });
});

describe("agent identity", () => {
  it("is the Rius spelling of the conventions' agent keys", () => {
    expect(semconv.GEN_AI_AGENT_NAME).toBe("gen_ai.agent.name");
    expect(semconv.GEN_AI_AGENT_ID).toBe("gen_ai.agent.id");
  });

  it("is pending identity, not content: known at start, never sensitive", () => {
    for (const key of [semconv.GEN_AI_AGENT_NAME, semconv.GEN_AI_AGENT_ID]) {
      expect(semconv.PENDING_IDENTITY_ATTRIBUTES.has(key)).toBe(true);
      expect(semconv.CONTENT_ATTRIBUTES.has(key)).toBe(false);
    }
  });

  it("is not part of the kind taxonomy: the keys name a target, not a kind", () => {
    // Set alongside dataSourceId in creationAttributes, where the other
    // caller-supplied target identifiers live.
    expect(kindAttributes(SpanKind.AGENT)).toEqual({
      "openinference.span.kind": "AGENT",
      "gen_ai.operation.name": "invoke_agent",
    });
  });
});
