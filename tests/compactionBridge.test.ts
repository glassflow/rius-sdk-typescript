/**
 * The compacted-context flag on spans another SDK's provider creates, which
 * Rius sees through the bridge: its pipeline starts on a twin of the span and
 * ends on a copy, never on the span the other SDK holds.
 *
 * The OpenInference tracer starts a span bare and sets its kind afterwards,
 * so under the bridge the flag is decided at end, on an object that is not
 * the one seen at start.
 */
import { context, propagation, type Span, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterEach, describe, expect, it } from "vitest";
import { getTracer, init, type RiusClient } from "../src/client.js";
import { markCompaction } from "../src/markCompaction.js";
import { GEN_AI_CONVERSATION_COMPACTED, OPENINFERENCE_SPAN_KIND } from "../src/semconv.js";

let client: RiusClient | undefined;
let foreign: NodeTracerProvider | undefined;

afterEach(async () => {
  await client?.shutdown();
  await foreign?.shutdown();
  client = undefined;
  foreign = undefined;
  trace.disable();
  context.disable();
  propagation.disable();
});

/** markCompaction leaves a flag in the async context it ran in; run each test in a fresh one. */
function isolated(fn: () => Promise<void>): () => Promise<void> {
  return () =>
    new Promise<void>((resolve, reject) => {
      setImmediate(() => fn().then(resolve, reject));
    });
}

/** Another SDK as the process's provider, and Rius bridged onto it. */
function bridged(): InMemorySpanExporter {
  foreign = new NodeTracerProvider({ spanProcessors: [] });
  foreign.register();
  const exporter = new InMemorySpanExporter();
  client = init({
    spanExporter: exporter,
    heartbeat: false,
    serviceName: "bridge-compaction-test",
    bridgeForeignProvider: true,
  });
  return exporter;
}

/** A span the way the OpenInference tracer makes one: bare, and its kind set after the start. */
function bareSpan(name: string, kind: string): Span {
  const span = foreign?.getTracer("openinference").startSpan(name) as Span;
  span.setAttribute(OPENINFERENCE_SPAN_KIND, kind);
  return span;
}

async function spansByName(exporter: InMemorySpanExporter): Promise<Map<string, ReadableSpan>> {
  await client?.flush();
  return new Map(exporter.getFinishedSpans().map((span) => [span.name, span]));
}

describe("a bridged span", () => {
  it(
    "that sets its kind after it starts is flagged compacted",
    isolated(async () => {
      const exporter = bridged();
      markCompaction();
      bareSpan("OpenAI Chat", "LLM").end();
      const spans = await spansByName(exporter);
      expect(spans.get("OpenAI Chat")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
    }),
  );

  it(
    "takes the mark once: a later span that is an LLM from its start is not flagged",
    isolated(async () => {
      const exporter = bridged();
      markCompaction();
      bareSpan("first", "LLM").end();
      getTracer()
        .startSpan("second", { attributes: { [OPENINFERENCE_SPAN_KIND]: "LLM" } })
        .end();
      const spans = await spansByName(exporter);
      expect(spans.get("first")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
      expect(spans.get("second")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
    }),
  );

  it(
    "that turns out not to be an LLM span leaves the mark for the one that is",
    isolated(async () => {
      const exporter = bridged();
      markCompaction();
      bareSpan("tool", "TOOL").end();
      bareSpan("call", "LLM").end();
      const spans = await spansByName(exporter);
      expect(spans.get("tool")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
      expect(spans.get("call")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
    }),
  );

  it(
    "gives the flag to the first of overlapping bridged spans to end",
    isolated(async () => {
      const exporter = bridged();
      markCompaction();
      const outer = bareSpan("outer", "LLM");
      const inner = bareSpan("inner", "LLM");
      inner.end();
      outer.end();
      const spans = await spansByName(exporter);
      expect(spans.get("inner")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBe(true);
      expect(spans.get("outer")?.attributes[GEN_AI_CONVERSATION_COMPACTED]).toBeUndefined();
    }),
  );
});
