import { describe, expect, it } from "vitest";
import * as rius from "../src/index.js";

describe("public API", () => {
  it("exports exactly the intended surface", () => {
    expect(Object.keys(rius).sort()).toEqual(
      [
        "Generation",
        "Observation",
        "RiusClient",
        "SpanKind",
        "VERSION",
        "getTracer",
        "init",
        "observe",
        "registerWorkspace",
        "startAsCurrentGeneration",
        "startAsCurrentSpan",
        "startGeneration",
        "startSpan",
        "withSession",
        "withWorkspace",
      ].sort(),
    );
  });

  it("keeps the naming contract discoverable", () => {
    expect(typeof rius.startAsCurrentSpan).toBe("function");
    expect(typeof rius.startSpan).toBe("function");
  });
});
