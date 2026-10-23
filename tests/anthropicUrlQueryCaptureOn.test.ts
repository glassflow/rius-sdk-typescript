import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, type RiusClient } from "../src/client.js";
import { URL_FULL, URL_QUERY } from "../src/semconv.js";
import {
  emptyPageServer,
  HAS_MEMORY_STORES,
  listMemories,
  PATH_PREFIX,
} from "./anthropicMemories.js";
import { isNative, TRACES_ITSELF } from "./anthropicMessages.js";

// The control for anthropicUrlQueryCaptureOff.test.ts: the same call with
// Rius capturing content, where the SDK's url.query and url.full keep the
// path_prefix. Without it the capture-off test could pass on a run whose SDK
// never wrote the query.
//
// A file of its own: the OpenInference packages keep module-level patch state,
// and vitest's per-file module isolation keeps that state to this file.

let exporter: InMemorySpanExporter;
let rius: RiusClient;
let server: { url: string; close: () => void };

beforeAll(async () => {
  exporter = new InMemorySpanExporter();
  rius = init({ spanExporter: exporter, heartbeat: false, captureContent: true });
  await rius.ready;
  server = await emptyPageServer();
});

afterAll(async () => {
  server.close();
  await rius.shutdown();
});

describe("the Anthropic SDK's URL query in its content mode, with captureContent on", () => {
  it.runIf(TRACES_ITSELF && HAS_MEMORY_STORES)(
    "exports the call's URL with its query",
    async () => {
      exporter.reset();
      await listMemories(server.url);
      await rius.flush();
      const spans = exporter.getFinishedSpans();

      const native = spans.filter(isNative);
      expect(native).toHaveLength(1);
      expect(native[0].attributes[URL_QUERY]).toContain(PATH_PREFIX);
      expect(native[0].attributes[URL_FULL]).toContain(PATH_PREFIX);
    },
  );
});
