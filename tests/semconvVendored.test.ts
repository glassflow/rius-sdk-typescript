import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as generated from "../src/semconv.generated.js";
import * as semconv from "../src/semconv.js";

// src/semconv.ts re-exports the module vendored from rius-semconv rather than
// redefining it. The semconv-vendored workflow checks the vendored copy is
// byte-identical to its pinned release; these check the hand-written module
// serves it unchanged, so no constant is shadowed by a stale hand-typed copy.
describe("the vendored semconv module", () => {
  it("is served by semconv.ts unchanged, name for name", () => {
    const names = Object.keys(generated);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect((semconv as Record<string, unknown>)[name], name).toBe(
        (generated as Record<string, unknown>)[name],
      );
    }
  });

  it("is the only place semconv.ts gets a constant from", () => {
    const source = readFileSync(new URL("../src/semconv.ts", import.meta.url), "utf8");
    expect(source.match(/^(export )?(const|enum) /gm)).toBeNull();
  });

  it("names the rius-semconv release it was vendored from", () => {
    const source = readFileSync(new URL("../src/semconv.generated.ts", import.meta.url), "utf8");
    expect(source.split("\n")[0]).toMatch(
      /^\/\/ Vendored from rius-semconv v\d+\.\d+\.\d+ out\/typescript\/semconv\.generated\.ts by$/,
    );
  });
});

// Registry keys the SDK once spelled by hand. Each is imported from semconv.ts
// now, so a hand-typed copy cannot drift from the registry.
const REGISTRY_KEYS = [
  "SERVICE_NAME",
  "EXCEPTION_MESSAGE",
  "EXCEPTION_STACKTRACE",
  "GEN_AI_SYSTEM_INSTRUCTIONS",
  "GEN_AI_TOOL_CALL_ARGUMENTS",
  "GEN_AI_TOOL_CALL_RESULT",
  "LLM_SYSTEM",
  "LLM_PROVIDER",
  "GEN_AI_SYSTEM",
  "LLM_REQUEST_MODEL_NAME",
  "LLM_RESPONSE_MODEL_NAME",
  "TOOL_NAME",
  "LLM_FINISH_REASON",
  "EMBEDDING_MODEL_NAME",
  "METADATA",
  "OUTPUT_MIME_TYPE",
  "GEN_AI_CLIENT_OPERATION_TIME_TO_FIRST_CHUNK",
  "AI_OPERATION_ID",
  "LLM_TOKEN_COUNT_PREFIX",
  "LLM_TOKEN_COUNT_PROMPT",
  "LLM_TOKEN_COUNT_COMPLETION",
  "LLM_TOKEN_COUNT_TOTAL",
  "LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ",
  "LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE",
  "LLM_TOKEN_COUNT_PROMPT_DETAILS_AUDIO",
  "LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING",
  "LLM_TOKEN_COUNT_COMPLETION_DETAILS_AUDIO",
  "GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS",
  "GEN_AI_USAGE_INPUT_TOKEN_DETAILS_AUDIO_TOKENS",
  "GEN_AI_USAGE_DETAILS_REASONING_TOKENS",
  "GEN_AI_USAGE_DETAILS_THINKING_TOKENS",
  "GEN_AI_USAGE_DETAILS_THOUGHTS_TOKENS",
  "GEN_AI_USAGE_DETAILS_IMAGE_PROMPT_TOKENS",
  "GEN_AI_USAGE_DETAILS_IMAGE_CACHE_TOKENS",
  "GEN_AI_USAGE_DETAILS_IMAGE_CANDIDATES_TOKENS",
  "GEN_AI_USAGE_DETAILS_INPUT_AUDIO_TOKENS",
  "GEN_AI_USAGE_DETAILS_CACHE_AUDIO_READ_TOKENS",
  "GEN_AI_USAGE_DETAILS_OUTPUT_AUDIO_TOKENS",
  "GEN_AI_USAGE_DETAILS_AUDIO_PROMPT_TOKENS",
  "GEN_AI_USAGE_DETAILS_AUDIO_CACHE_TOKENS",
  "GEN_AI_USAGE_DETAILS_AUDIO_CANDIDATES_TOKENS",
  "GEN_AI_USAGE_DETAILS_AUDIO_RESPONSE_TOKENS",
] as const;

describe("registry keys", () => {
  it("are imported, never typed by hand", () => {
    const values = new Map<string, string>();
    for (const name of REGISTRY_KEYS) {
      values.set((semconv as Record<string, unknown>)[name] as string, name);
    }
    const dir = new URL("../src/", import.meta.url);
    const found: string[] = [];
    for (const file of readdirSync(dir, { recursive: true }) as string[]) {
      if (!file.endsWith(".ts") || file.endsWith("semconv.generated.ts")) continue;
      const text = readFileSync(new URL(file, dir), "utf8");
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          const name = values.get(node.text);
          if (name !== undefined) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart());
            found.push(`${file}:${line + 1} "${node.text}" (${name})`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(found).toEqual([]);
  });
});
