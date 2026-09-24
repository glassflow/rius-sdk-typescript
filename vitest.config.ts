import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Several suites do real work rather than mock it: they lazily import `ai`
    // and `@ai-sdk/*` (which vitest must transform on first use), start stub
    // HTTP servers and patch instrumentation. On an idle machine each of those
    // tests finishes in well under a second, but the suite runs one worker per
    // core, so under contention the same test can take ten times as long and
    // blow vitest's 5s default. That deadline is a wall-clock bet, not a
    // correctness bound, and losing it used to look like a real regression:
    // the timed-out test kept running (vitest cannot abort a test body), held
    // the process-global client that init() hands back, and every later test
    // in the file then failed against state the timed-out one still owned.
    // 30s is long enough that only a genuine hang trips it.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
