export const VERSION = "0.1.0";

export { RiusClient, getTracer, init } from "./client.js";
export type { InitOptions } from "./client.js";
export type { Mask, RiusOptions } from "./config.js";
export { Generation, startAsCurrentGeneration, startGeneration } from "./generation.js";
export type { GenerationOptions } from "./generation.js";
export { observe } from "./observe.js";
export type { ObserveOptions } from "./observe.js";
export { SpanKind } from "./semconv.js";
export { Observation, startAsCurrentSpan, startSpan } from "./spans.js";
export type { SpanOptions } from "./spans.js";
