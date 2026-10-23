import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, type RiusClient } from "../src/client.js";
import { URL_FULL, URL_QUERY } from "../src/semconv.js";
import {
  emptyPageServer,
  HAS_MEMORY_STORES,
  listMemories,
  PATH_PREFIX,
  STORE,
} from "./anthropicMemories.js";
import { isNative, TRACES_ITSELF } from "./anthropicMessages.js";

// A call of the Anthropic SDK's with a query parameter the SDK treats as
// content (a memory list's path_prefix), run in the SDK's content mode, with
// Rius set to capture no content. The SDK writes the query to url.query and
// url.full on its own span; neither may carry it out of the process, and the
// span keeps the rest of its URL.
//
// A file of its own: the OpenInference packages keep module-level patch state,
// and vitest's per-file module isolation keeps that state to this file.

let exporter: InMemorySpanExporter;
let rius: RiusClient;
let server: { url: string; close: () => void };

beforeAll(async () => {
  exporter = new InMemorySpanExporter();
  rius = init({ spanExporter: exporter, heartbeat: false, captureContent: false });
  await rius.ready;
  server = await emptyPageServer();
});

afterAll(async () => {
  server.close();
  await rius.shutdown();
});

describe("the Anthropic SDK's URL query in its content mode, with captureContent off", () => {
  it.runIf(TRACES_ITSELF && HAS_MEMORY_STORES)(
    "exports the call's URL without its query",
    async () => {
      exporter.reset();
      await listMemories(server.url);
      await rius.flush();
      const spans = exporter.getFinishedSpans();

      const native = spans.filter(isNative);
      expect(native).toHaveLength(1);
      const { attributes } = native[0];
      expect(attributes[URL_QUERY]).toBeUndefined();
      expect(attributes[URL_FULL]).toBe(`${server.url}/v1/memory_stores/${STORE}/memories`);
      for (const span of spans) {
        expect(JSON.stringify(span.attributes), span.name).not.toContain(PATH_PREFIX);
      }
    },
  );
});
