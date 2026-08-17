import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RiusClient, init } from "../src/client.js";
import { startSpan } from "../src/spans.js";

/**
 * The one test that talks to a real HTTP server: the Rius ingest accepts only
 * OTLP protobuf (a JSON export is refused with 415 Unsupported Media Type), so
 * the default exporter's wire encoding is part of the backend contract, the
 * same way the Python SDK's opentelemetry-exporter-otlp-proto-http is. A unit
 * test with an injected exporter can never catch this, which is exactly how a
 * JSON exporter shipped in the first place.
 */
describe("default exporter wire format", () => {
  let client: RiusClient;
  let server: http.Server;

  afterEach(async () => {
    await client.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("exports OTLP protobuf with the bearer header", async () => {
    const received: Array<{ contentType?: string; authorization?: string }> = [];
    server = http.createServer((request, response) => {
      received.push({
        contentType: request.headers["content-type"],
        authorization: request.headers.authorization,
      });
      request.resume();
      request.on("end", () => {
        response.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    client = init({
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: "k",
      serviceName: "wire-test",
      heartbeatTransport: async () => {},
    });
    startSpan("wire-span").end();
    await client.flush();

    expect(received.length).toBeGreaterThan(0);
    expect(received[0].contentType).toBe("application/x-protobuf");
    expect(received[0].authorization).toBe("Bearer k");
  });
});
