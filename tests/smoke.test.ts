import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

describe("package", () => {
  it("exports a semver VERSION", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
