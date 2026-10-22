import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";
import { SDK_VERSION } from "../src/version.js";

describe("SDK_VERSION", () => {
  it("is the exported VERSION", () => {
    expect(SDK_VERSION).toBe(VERSION);
  });

  it("is the SDK's own version inside an application's bundle", async () => {
    // A bundler inlines the SDK into the app's output, so anything resolved
    // relative to the module at runtime finds the APP's package.json.
    const app = mkdtempSync(join(tmpdir(), "rius-bundle-"));
    try {
      writeFileSync(
        join(app, "package.json"),
        JSON.stringify({ name: "myapp", version: "9.9.9", type: "module" }),
      );
      mkdirSync(join(app, "dist"));
      const outfile = join(app, "dist", "app.mjs");
      await build({
        entryPoints: [new URL("../src/version.ts", import.meta.url).pathname],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile,
        logLevel: "silent",
      });
      const bundled = (await import(pathToFileURL(outfile).href)) as { SDK_VERSION: string };
      expect(bundled.SDK_VERSION).toBe(VERSION);
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });

  it("is the constant release-please bumps", () => {
    const config = JSON.parse(
      readFileSync(new URL("../release-please-config.json", import.meta.url), "utf8"),
    );
    expect(config.packages["."]["extra-files"]).toContain("src/version.ts");
    const source = readFileSync(new URL("../src/version.ts", import.meta.url), "utf8");
    expect(source).toMatch(/= "\d+\.\d+\.\d+[^"]*"; \/\/ x-release-please-version/);
  });
});
