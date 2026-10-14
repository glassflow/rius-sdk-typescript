import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as generated from "../src/semconv.generated.js";
import * as semconv from "../src/semconv.js";

// src/semconv.ts re-exports the module vendored from rius-semconv rather than
// redefining it. The semconv-parity workflow checks the vendored copy is
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
