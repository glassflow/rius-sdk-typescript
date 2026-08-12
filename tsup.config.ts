import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  target: "node18",
  // never bundle the API package: a second copy breaks context propagation
  external: ["@opentelemetry/api"],
});
