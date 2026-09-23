import { SpanKind as OtelSpanKind } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import * as semconv from "../src/semconv.js";
import { SpanKind, composeSpanName, kindAttributes, otelSpanKind } from "../src/semconv.js";
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
      semconv.GEN_AI_TOOL_CALL_ID,
      semconv.GEN_AI_TOOL_TYPE,
      semconv.GEN_AI_OUTPUT_TYPE,
      semconv.GEN_AI_DATA_SOURCE_ID,
      semconv.GEN_AI_RETRIEVAL_TOP_K,
      semconv.GEN_AI_AGENT_NAME,
      semconv.GEN_AI_AGENT_ID,
      semconv.GEN_AI_AGENT_VERSION,
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

describe("agent identity keys", () => {
  it("spells the invoked agent's version as the GenAI registry does", () => {
    expect(semconv.GEN_AI_AGENT_VERSION).toBe("gen_ai.agent.version");
  });

  it("spells the process-level agent identity in the rius namespace", () => {
    expect(semconv.RIUS_MAIN_AGENT_NAME).toBe("rius.main_agent.name");
    expect(semconv.RIUS_MAIN_AGENT_ID).toBe("rius.main_agent.id");
    expect(semconv.RIUS_MAIN_AGENT_DESCRIPTION).toBe("rius.main_agent.description");
    expect(semconv.RIUS_MAIN_AGENT_VERSION).toBe("rius.main_agent.version");
  });

  it("keeps the three versions distinct keys, so none can be read as another", () => {
    // service.version is the deployment build, rius.main_agent.version the
    // agent definition this process runs, gen_ai.agent.version the agent a
    // span invoked. Nothing derives one from another, so nothing may collapse
    // two of them onto one key either.
    const versions = new Set([
      "service.version",
      semconv.RIUS_MAIN_AGENT_VERSION,
      semconv.GEN_AI_AGENT_VERSION,
    ]);
    expect(versions.size).toBe(3);
  });

  it("carries no main-agent key onto a span: they are resource-level facts", () => {
    for (const key of [
      semconv.RIUS_MAIN_AGENT_NAME,
      semconv.RIUS_MAIN_AGENT_ID,
      semconv.RIUS_MAIN_AGENT_DESCRIPTION,
      semconv.RIUS_MAIN_AGENT_VERSION,
    ]) {
      expect(semconv.PENDING_IDENTITY_ATTRIBUTES.has(key)).toBe(false);
      expect(semconv.CONTENT_ATTRIBUTES.has(key)).toBe(false);
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

// The conventions' span name, composed from the attributes the span carries.
describe("composeSpanName", () => {
  it("renders {operation} {target} for every kind that has one", () => {
    const cases: [SpanKind, Record<string, string>, string][] = [
      [SpanKind.LLM, { "gen_ai.request.model": "gpt-4o" }, "chat gpt-4o"],
      [
        SpanKind.EMBEDDING,
        { "gen_ai.request.model": "text-embedding-3-small" },
        "embeddings text-embedding-3-small",
      ],
      [SpanKind.TOOL, { "gen_ai.tool.name": "get_weather" }, "execute_tool get_weather"],
      [SpanKind.AGENT, { "gen_ai.agent.name": "planner" }, "invoke_agent planner"],
      [SpanKind.RETRIEVER, { "gen_ai.data_source.id": "docs-index" }, "retrieval docs-index"],
    ];
    for (const [kind, target, expected] of cases) {
      expect(composeSpanName(kind, { ...kindAttributes(kind), ...target })).toBe(expected);
    }
  });

  it("falls back to the bare operation when the target is unknown", () => {
    const expected: [SpanKind, string][] = [
      [SpanKind.LLM, "chat"],
      [SpanKind.EMBEDDING, "embeddings"],
      [SpanKind.TOOL, "execute_tool"],
      [SpanKind.AGENT, "invoke_agent"],
      [SpanKind.RETRIEVER, "retrieval"],
    ];
    for (const [kind, name] of expected) {
      expect(composeSpanName(kind, kindAttributes(kind))).toBe(name);
    }
  });

  it("reads the operation off the attributes, so an override renames the span", () => {
    // A generation may be a text_completion or an embeddings call; the name
    // must follow the operation that is actually on the span.
    expect(
      composeSpanName(SpanKind.LLM, {
        ...kindAttributes(SpanKind.LLM),
        "gen_ai.operation.name": "embeddings",
        "gen_ai.request.model": "text-embedding-3-small",
      }),
    ).toBe("embeddings text-embedding-3-small");
  });

  it("uses the literal chain for a CHAIN, the one kind with no operation", () => {
    expect(composeSpanName(SpanKind.CHAIN, kindAttributes(SpanKind.CHAIN))).toBe("chain");
  });

  it("ignores an empty target rather than trailing a space", () => {
    expect(
      composeSpanName(SpanKind.TOOL, { ...kindAttributes(SpanKind.TOOL), "gen_ai.tool.name": "" }),
    ).toBe("execute_tool");
  });

  it("ignores a target belonging to another kind", () => {
    // Keys are read per kind, so a tool name on an agent span cannot leak
    // into the agent span's name.
    expect(
      composeSpanName(SpanKind.AGENT, {
        ...kindAttributes(SpanKind.AGENT),
        "gen_ai.tool.name": "get_weather",
      }),
    ).toBe("invoke_agent");
  });
});

describe("conformance keys added for the GenAI registry sweep", () => {
  // Verified against semantic-conventions-genai @ 8ffdf568e1b4391a99adb081db16e8102e36918e
  // (model/gen-ai/registry.yaml, model/gen-ai/spans.yaml). The repo has no
  // releases, so the commit is the citation.
  it("spells each key the way the registry does", () => {
    expect(semconv.GEN_AI_RESPONSE_ID).toBe("gen_ai.response.id");
    expect(semconv.GEN_AI_OUTPUT_TYPE).toBe("gen_ai.output.type");
    expect(semconv.GEN_AI_TOOL_CALL_ID).toBe("gen_ai.tool.call.id");
    expect(semconv.GEN_AI_TOOL_TYPE).toBe("gen_ai.tool.type");
  });

  it("treats none of them as content: they survive captureContent: false", () => {
    // Ids, a modality and a tool category. Nothing the model was shown, and
    // none of them marked sensitive by the conventions — unlike
    // gen_ai.tool.call.arguments, which sits one key away and IS content.
    for (const key of [
      semconv.GEN_AI_RESPONSE_ID,
      semconv.GEN_AI_OUTPUT_TYPE,
      semconv.GEN_AI_TOOL_CALL_ID,
      semconv.GEN_AI_TOOL_TYPE,
    ]) {
      expect(semconv.CONTENT_ATTRIBUTES.has(key), `${key} must not be content`).toBe(false);
    }
    expect(semconv.CONTENT_ATTRIBUTES.has("gen_ai.tool.call.arguments")).toBe(true);
  });

  it("allowlists the three request-side keys and excludes the response-side one", () => {
    // Identity is exactly "knowable when the span is created".
    for (const key of [
      semconv.GEN_AI_OUTPUT_TYPE,
      semconv.GEN_AI_TOOL_CALL_ID,
      semconv.GEN_AI_TOOL_TYPE,
    ]) {
      expect(semconv.PENDING_IDENTITY_ATTRIBUTES.has(key), `${key} must ride snapshots`).toBe(true);
    }
    // The completion id arrives with the response, so no snapshot can carry it.
    expect(semconv.PENDING_IDENTITY_ATTRIBUTES.has(semconv.GEN_AI_RESPONSE_ID)).toBe(false);
  });

  it("needs its own allowlist entry for the output type, which no prefix covers", () => {
    // gen_ai.output.type is a request property spelled outside
    // gen_ai.request., so PENDING_IDENTITY_PREFIXES cannot reach it.
    const covered = semconv.PENDING_IDENTITY_PREFIXES.some((prefix) =>
      semconv.GEN_AI_OUTPUT_TYPE.startsWith(prefix),
    );
    expect(covered).toBe(false);
  });

  it("keeps the tool keys out of the span name, which names the tool only", () => {
    expect(
      composeSpanName(SpanKind.TOOL, {
        ...kindAttributes(SpanKind.TOOL, "get_weather"),
        [semconv.GEN_AI_TOOL_CALL_ID]: "call_abc123",
        [semconv.GEN_AI_TOOL_TYPE]: "function",
      }),
    ).toBe("execute_tool get_weather");
    // And a tool span with no tool name is still named after the operation
    // alone: neither new key may stand in as the name target.
    expect(
      composeSpanName(SpanKind.TOOL, {
        ...kindAttributes(SpanKind.TOOL),
        [semconv.GEN_AI_TOOL_CALL_ID]: "call_abc123",
        [semconv.GEN_AI_TOOL_TYPE]: "function",
      }),
    ).toBe("execute_tool");
  });

  it("keeps the output type out of a generation's span name", () => {
    expect(
      composeSpanName(SpanKind.LLM, {
        ...kindAttributes(SpanKind.LLM),
        "gen_ai.request.model": "gpt-4o",
        [semconv.GEN_AI_OUTPUT_TYPE]: "json",
      }),
    ).toBe("chat gpt-4o");
  });
});
