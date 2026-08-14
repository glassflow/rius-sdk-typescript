import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  target: "node18",
  splitting: false,
  // never bundle the API package: a second copy breaks context propagation
  external: ["@opentelemetry/api"],
  // heartbeat.ts resolves its own version via createRequire(import.meta.url):
  // without this, tsup's CJS output stubs import.meta as `{}`, import.meta.url
  // is undefined, createRequire throws, and every CJS consumer silently reports
  // sdk_version "0.0.0" forever. Do not remove even if nothing else appears to
  // need it.
  shims: true,
});
