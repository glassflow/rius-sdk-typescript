import { createRequire } from "node:module";
import { Client as EsmClient } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";
import { REGISTRY } from "../src/instrumentation.js";

// The MCP SDK dual-builds (import -> dist/esm, require -> dist/cjs), so a CJS
// consumer's Client is a DIFFERENT class from the one the registry's dynamic
// import resolves. Patching only the ESM build makes a CJS app's tool calls
// invisible while ready still reports "mcp" — the packed-consumer CI legs are
// the authoritative proof, this pins the same behavior at unit level. In its
// own file because requiring the CJS build here would poison any future test
// that depends on a "no CJS build loaded" precondition.

const require = createRequire(import.meta.url);

type Wrapped = { riusOriginal?: unknown };

function callToolOf(cls: unknown): Wrapped {
  return (cls as { prototype: { callTool: Wrapped } }).prototype.callTool;
}

describe("mcp entry across builds", () => {
  it("patches both the CJS and the ESM Client builds", async () => {
    const cjs = require("@modelcontextprotocol/sdk/client/index.js") as {
      Client: typeof EsmClient;
    };

    const entry = REGISTRY.find((candidate) => candidate.name === "mcp");
    expect(entry).toBeDefined();
    const loaded = await entry?.load();
    expect(loaded).toBeDefined();

    expect(callToolOf(EsmClient).riusOriginal, "ESM build unpatched").toBeTypeOf("function");
    expect(callToolOf(cjs.Client).riusOriginal, "CJS build unpatched").toBeTypeOf("function");
  });
});
