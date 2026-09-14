import { createRequire } from "node:module";

/**
 * The SDK's own version, for the tracer scope, the `telemetry.distro.version`
 * resource attribute and the heartbeat payload.
 *
 * Resolved once at module load, the same way the OTLP exporter's user-agent
 * reads its own version: `package.json` is one directory up from both
 * `src/*.ts` (during tests) and the bundled `dist/*.js` (at runtime). Not the
 * `VERSION` constant in index.ts: importing that here would make every module
 * depend on the package entry point.
 */
export const SDK_VERSION: string = (() => {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
