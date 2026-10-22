import { beforeEach } from "vitest";
import { resetWarnOnce } from "../src/warn.js";

// Warnings are deduplicated per process; each test asserts on its own.
beforeEach(() => {
  resetWarnOnce();
});
