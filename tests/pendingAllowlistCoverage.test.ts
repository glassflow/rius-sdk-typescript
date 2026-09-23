import type { Context } from "@opentelemetry/api";
import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RiusClient, init, spanProcessorSink } from "../src/client.js";
import { startGeneration } from "../src/generation.js";
import { instrumentMcpClient } from "../src/instrumentationMcp.js";
import {
  PENDING_IDENTITY_ATTRIBUTES,
  PENDING_IDENTITY_PREFIXES,
  SpanKind,
  kindAttributes,
} from "../src/semconv.js";
import { startAsCurrentSpan, startSpan } from "../src/spans.js";

/**
 * PENDING_IDENTITY_ATTRIBUTES is an allowlist, so an identity key added to a
 * creation-attribute builder without an allowlist update is silently dropped
 * from pending snapshots (this is how the MCP marker went missing once).
 * Every key the SDK itself sets at span creation must pass it.
 */

/** Records each span's attributes as they are at onStart, i.e. the creation attributes. */
class StartAttributeRecorder implements SpanProcessor {
  readonly seen = new Map<string, Record<string, unknown>>();
  onStart(span: Span, _context: Context): void {
    this.seen.set(span.name, { ...span.attributes });
  }
  onEnd(): void {}
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

class FakeMcpClient {
  get transport(): { protocolVersion?: string } {
    return { protocolVersion: "2026-07-28" };
  }
  async callTool(_params: { name: string; arguments?: unknown }): Promise<unknown> {
    return { content: [{ type: "text", text: "ok" }] };
  }
}

function isAllowlisted(key: string): boolean {
  return (
    PENDING_IDENTITY_ATTRIBUTES.has(key) || PENDING_IDENTITY_PREFIXES.some((p) => key.startsWith(p))
  );
}

function expectAllowlisted(builder: string, attributes: Record<string, unknown>): void {
  for (const key of Object.keys(attributes)) {
    expect(
      isAllowlisted(key),
      `${builder} sets "${key}" at creation but it is not pending-allowlisted`,
    ).toBe(true);
  }
}

let client: RiusClient;
let recorder: StartAttributeRecorder;
let uninstrument: () => void;

beforeEach(() => {
  client = init({ spanExporter: new InMemorySpanExporter(), heartbeatTransport: async () => {} });
  recorder = new StartAttributeRecorder();
  spanProcessorSink(client).add(recorder);
  uninstrument = instrumentMcpClient(FakeMcpClient);
});
afterEach(async () => {
  uninstrument();
  await client.shutdown();
});

describe("pending allowlist coverage", () => {
  it("every creation-time identity key is allowlisted for pending snapshots", async () => {
    for (const kind of Object.values(SpanKind)) {
      expectAllowlisted(`kindAttributes(${kind})`, kindAttributes(kind, "tool-name"));
    }

    startSpan("manual-tool", { kind: SpanKind.TOOL, userId: "u", input: { q: "x" } }).end();
    await startAsCurrentSpan("scoped-tool", { kind: SpanKind.TOOL, userId: "u" }, async () => 1);
    startGeneration("gen", { model: "m", provider: "p", operation: "chat", userId: "u" }).end();
    startSpan("retrieve", {
      kind: SpanKind.RETRIEVER,
      dataSourceId: "docs-index",
      userId: "u",
    }).end();
    await new FakeMcpClient().callTool({ name: "search", arguments: { q: "x" } });
    // Inside an AGENT scope, where a TOOL span additionally carries the name
    // of the agent executing it — an identity key set at creation like any
    // other, so the allowlist has to cover it too.
    await startAsCurrentSpan({ kind: SpanKind.AGENT, agentName: "planner" }, async () => {
      await startAsCurrentSpan("scoped-tool-in-agent", { kind: SpanKind.TOOL }, async () => 1);
      await new FakeMcpClient().callTool({ name: "remote", arguments: { q: "x" } });
    });

    const expected = [
      "manual-tool",
      "scoped-tool",
      "gen",
      "retrieve",
      "execute_tool search",
      "invoke_agent planner",
      "scoped-tool-in-agent",
      "execute_tool remote",
    ];
    expect([...recorder.seen.keys()].sort()).toEqual([...expected].sort());
    for (const name of expected) {
      expectAllowlisted(name, recorder.seen.get(name) as Record<string, unknown>);
    }
  });
});
