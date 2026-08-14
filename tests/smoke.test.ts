import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

describe("package", () => {
  it("exports a semver VERSION", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("exports the VERSION that matches package.json", () => {
    // The constant is hand-written and bumped by release-please's extra-files
    // updater. This guards the drift that shipped 0.1.0's VERSION inside the
    // 0.2.1 package: without it, only the semver-shape check above ran, and a
    // stale constant is still a valid semver.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
});
