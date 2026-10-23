import http from "node:http";
import { createRequire } from "node:module";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, type RiusClient } from "../src/client.js";
import { GEN_AI_OPERATION_NAME, GEN_AI_TOOL_NAME } from "../src/semconv.js";
import { isNative, TRACES_ITSELF } from "./anthropicMessages.js";

// The Anthropic SDK's tool runner, run in the SDK's content mode, with Rius
// set to capture no content. The SDK records the tool's arguments and its
// output on its own execute_tool span, the prompt and the reply on its chat
// spans; none of it may leave the process. The tool's span still exports,
// with what identifies the run.
//
// A file of its own: the OpenInference packages keep module-level patch state,
// and vitest's per-file module isolation keeps that state to this file.

const require = createRequire(import.meta.url);

const SECRETS = {
  system: "SECRET-SYSTEM-7c1e",
  prompt: "SECRET-PROMPT-2b9d",
  arguments: "SECRET-ARGUMENTS-4f03",
  output: "SECRET-TOOL-OUTPUT-91aa",
  preamble: "SECRET-PREAMBLE-5d62",
  reply: "SECRET-REPLY-e840",
};

const TOOL_NAME = "lookup_record";

interface ToolRunner {
  runUntilDone(): Promise<unknown>;
}

interface ToolRunnerClient {
  beta: { messages: { toolRunner(body: unknown): ToolRunner } };
}

const Anthropic = (
  require("@anthropic-ai/sdk") as {
    default: new (options: {
      apiKey: string;
      baseURL: string;
      maxRetries: number;
      openTelemetry?: { traces: { contentMode: "content" | "metadata_only" } };
    }) => ToolRunnerClient;
  }
).default;

const { betaTool } = require("@anthropic-ai/sdk/helpers/beta/json-schema") as {
  betaTool(options: {
    name: string;
    description: string;
    inputSchema: unknown;
    run: (args: { id: string }) => string;
  }): unknown;
};

const USAGE = { input_tokens: 5, output_tokens: 1 };

function message(content: unknown[], stopReason: string): unknown {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: USAGE,
  };
}

/** Asks for the tool first, then answers once the request carries its result. */
async function toolServer(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const answered = body.includes('"tool_result"');
      const reply = answered
        ? message([{ type: "text", text: SECRETS.reply }], "end_turn")
        : message(
            [
              { type: "text", text: SECRETS.preamble },
              {
                type: "tool_use",
                id: "toolu_1",
                name: TOOL_NAME,
                input: { id: SECRETS.arguments },
              },
            ],
            "tool_use",
          );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

let exporter: InMemorySpanExporter;
let rius: RiusClient;
let server: { url: string; close: () => void };

beforeAll(async () => {
  exporter = new InMemorySpanExporter();
  rius = init({ spanExporter: exporter, heartbeat: false, captureContent: false });
  expect(await rius.ready).toContain("anthropic");
  server = await toolServer();
});

afterAll(async () => {
  server.close();
  await rius.shutdown();
});

/** Everything a span exports that could carry text. */
function exportedText(span: ReadableSpan): string {
  return JSON.stringify({
    name: span.name,
    attributes: span.attributes,
    events: span.events.map((event) => ({ name: event.name, attributes: event.attributes })),
    status: span.status,
  });
}

describe("the Anthropic SDK's tool runner in its content mode, with captureContent off", () => {
  it.runIf(TRACES_ITSELF)("exports the tool run without its arguments or output", async () => {
    let ran = 0;
    const client = new Anthropic({
      apiKey: "not-a-real-key",
      baseURL: server.url,
      maxRetries: 0,
      openTelemetry: { traces: { contentMode: "content" } },
    });
    const lookup = betaTool({
      name: TOOL_NAME,
      description: "Looks a record up by id.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      run: () => {
        ran += 1;
        return SECRETS.output;
      },
    });

    exporter.reset();
    await client.beta.messages
      .toolRunner({
        model: "claude-test",
        max_tokens: 16,
        system: SECRETS.system,
        messages: [{ role: "user", content: SECRETS.prompt }],
        tools: [lookup],
      })
      .runUntilDone();
    await rius.flush();
    const spans = exporter.getFinishedSpans();

    expect(ran).toBe(1);
    const tool = spans.filter(
      (span) => isNative(span) && span.attributes[GEN_AI_OPERATION_NAME] === "execute_tool",
    );
    expect(tool).toHaveLength(1);
    expect(tool[0].attributes[GEN_AI_TOOL_NAME]).toBe(TOOL_NAME);

    for (const span of spans) {
      const text = exportedText(span);
      for (const [what, secret] of Object.entries(SECRETS)) {
        expect(text, `${what} on ${span.name}`).not.toContain(secret);
      }
    }
  });
});
