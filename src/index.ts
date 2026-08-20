export const VERSION = "0.3.0"; // x-release-please-version

export { RiusClient, getTracer, init } from "./client.js";
export type { InitOptions } from "./client.js";
export type { Mask, RiusOptions } from "./config.js";
export { Generation, startAsCurrentGeneration, startGeneration } from "./generation.js";
export type { GenerationBody, GenerationOptions } from "./generation.js";
export { observe } from "./observe.js";
export type { ObserveOptions } from "./observe.js";
export { SpanKind } from "./semconv.js";
export { withSession } from "./session.js";
export { Observation, startAsCurrentSpan, startSpan } from "./spans.js";
export type { SpanBody, SpanOptions } from "./spans.js";
