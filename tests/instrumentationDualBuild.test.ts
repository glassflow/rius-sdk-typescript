import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { anthropicPatchable, cachedCjsExports, openaiPatchable } from "../src/instrumentation.js";

// Unit coverage for the dual-build helpers. In its own file because the
// cache-scanning tests require() the real provider SDKs, which would poison
// the "no CJS build loaded" precondition the ESM-path tests depend on.

const require = createRequire(import.meta.url);

describe("openaiPatchable", () => {
  it("rejects exports without the method the patch wraps", () => {
    expect(openaiPatchable({})).toBeUndefined();
    expect(openaiPatchable({ OpenAI: class {} })).toBeUndefined();
    expect(openaiPatchable({ default: { Chat: {} } })).toBeUndefined();
  });

  it("wraps the real class from either export style", () => {
    const cjs = require("openai") as Record<string, unknown>;
    const patchable = openaiPatchable(cjs) as { OpenAI?: unknown } | undefined;
    expect(patchable?.OpenAI).toBeDefined();
  });
});

describe("anthropicPatchable", () => {
  it("rejects exports without the method the patch wraps", () => {
    expect(anthropicPatchable({})).toBeUndefined();
    expect(anthropicPatchable({ Anthropic: class {} })).toBeUndefined();
  });

  it("wraps the real class from either export style", () => {
    const cjs = require("@anthropic-ai/sdk") as Record<string, unknown>;
    const patchable = anthropicPatchable(cjs) as { default?: unknown } | undefined;
    expect(patchable?.default).toBeDefined();
  });
});

describe("cachedCjsExports", () => {
  it("finds a required package's main exports through the shape test", () => {
    // The requires in the tests above populated the cache; the shape test is
    // what picks the main exports out of the package's many cached files.
    const found = cachedCjsExports("@anthropic-ai/sdk", anthropicPatchable) as
      | { default?: { Messages?: { prototype?: { create?: unknown } } } }
      | undefined;
    expect(found?.default?.Messages?.prototype?.create).toBeTypeOf("function");
  });

  it("returns undefined for a package that was never required", () => {
    expect(cachedCjsExports("@langchain/core", anthropicPatchable)).toBeUndefined();
    expect(cachedCjsExports("not-a-real-package", openaiPatchable)).toBeUndefined();
  });

  it("does not confuse a package with a similarly named sibling", () => {
    // "openai" is cached; the needle's surrounding separators must keep a
    // hypothetical "openai-extras" or a scoped lookalike from matching it.
    expect(cachedCjsExports("openai-extras", openaiPatchable)).toBeUndefined();
    expect(cachedCjsExports("open", openaiPatchable)).toBeUndefined();
  });
});
