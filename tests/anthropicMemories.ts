import http from "node:http";
import { createRequire } from "node:module";

// The Anthropic SDK's memory list, a call with a query parameter the SDK
// treats as content (path_prefix), against a local server that answers it.

const require = createRequire(import.meta.url);

export const PATH_PREFIX = "SECRET-PATH-PREFIX-3a7f";
export const STORE = "memstore_1";

interface MemoriesClient {
  beta: {
    memoryStores?: {
      memories: { list(store: string, params: { path_prefix: string }): Promise<unknown> };
    };
  };
}

const Anthropic = (
  require("@anthropic-ai/sdk") as {
    default: new (options: {
      apiKey: string;
      baseURL?: string;
      maxRetries?: number;
      openTelemetry?: { traces: { contentMode: "content" | "metadata_only" } };
    }) => MemoriesClient;
  }
).default;

/** Whether the installed SDK has memory stores (older ones trace but have none). */
export const HAS_MEMORY_STORES =
  new Anthropic({ apiKey: "not-a-real-key" }).beta.memoryStores !== undefined;

/** Lists the store's memories under PATH_PREFIX, in the SDK's content mode. */
export async function listMemories(baseURL: string): Promise<void> {
  const client = new Anthropic({
    apiKey: "not-a-real-key",
    baseURL,
    maxRetries: 0,
    openTelemetry: { traces: { contentMode: "content" } },
  });
  if (client.beta.memoryStores === undefined) throw new Error("this SDK has no memory stores");
  await client.beta.memoryStores.memories.list(STORE, { path_prefix: PATH_PREFIX });
}

/** Answers every request with an empty page. */
export async function emptyPageServer(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [], next_page: null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test setup: no port");
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}
