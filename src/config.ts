export const DEFAULT_ENDPOINT = "https://ingest.eu.console.rius-glassflow.com";
/**
 * What `service.name` AND `agentName` both resolve to when nothing was
 * configured. Exported so the span helpers can tell "the caller named their
 * agent" from "the caller named nothing", which read identically otherwise.
 */
export const DEFAULT_SERVICE_NAME = "unknown_service";

// The backend expresses staleness as multiples of the interval, so the clamp
// bounds are part of the heartbeat wire contract.
const HEARTBEAT_INTERVAL_MIN = 5;
const HEARTBEAT_INTERVAL_MAX = 300;
const DEFAULT_HEARTBEAT_INTERVAL = 15;

// Debounce for partial spans: 0 = emit immediately at span start;
// N>0 = emit only if the span is still open after N seconds. Beyond 60s a
// "live" view stops being live, so larger values are clamped.
const PARTIAL_SPANS_DELAY_MIN = 0;
const PARTIAL_SPANS_DELAY_MAX = 60;
const DEFAULT_PARTIAL_SPANS_DELAY = 0;

/** Redacts content attribute values at export. Receives the key when it accepts one. */
export type Mask = (value: unknown, context?: { key: string }) => unknown;

/**
 * Configuration shared by every client. Each option can also come from a
 * `RIUS_*` environment variable; explicit options win over the environment,
 * which wins over defaults.
 */
export interface RiusOptions {
  endpoint?: string;
  apiKey?: string;
  serviceName?: string;
  /**
   * The running build's version, stamped on the resource as `service.version`.
   * There is deliberately NO default: `service.name` already shows what a
   * missing value costs, where the `unknown_service` placeholder merges every
   * unconfigured process into one bucket. An absent version is a visibly
   * absent version, so the resource simply omits the key.
   *
   * Resolution: this option, then `RIUS_SERVICE_VERSION`, then
   * `service.version` inside `OTEL_RESOURCE_ATTRIBUTES`, then unset.
   */
  serviceVersion?: string;
  disabled?: boolean;
  sampleRate?: number;
  captureContent?: boolean;
  mask?: Mask;
  /** Seconds between agent-lifetime heartbeat pings. */
  heartbeatInterval?: number;
  heartbeat?: boolean;
  agentName?: string;
  partialSpans?: boolean;
  /** Seconds to debounce a pending-span snapshot after span start. */
  partialSpansDelay?: number;
  /**
   * Process-wide session id, stamped as `session.id` on every span. For
   * one-run-per-process agents; a server handling many sessions scopes each
   * one with `withSession()` instead, which overrides this default.
   */
  sessionId?: string;
}

export interface ResolvedConfig {
  endpoint: string;
  apiKey?: string;
  serviceName: string;
  /** Absent when nothing supplied one; never a placeholder. */
  serviceVersion?: string;
  disabled: boolean;
  sampleRate: number;
  captureContent: boolean;
  mask?: Mask;
  heartbeat: boolean;
  heartbeatIntervalMs: number;
  heartbeatEndpoint: string;
  agentName: string;
  partialSpans: boolean;
  partialSpansDelayMs: number;
  sessionId?: string;
}

type Env = Record<string, string | undefined>;

const AFFIRMATIVE = new Set(["1", "true", "yes", "on"]);
const NEGATIVE = new Set(["0", "false", "no", "off"]);

/**
 * Parses a boolean env var. An unrecognised value falls back to the default
 * and warns: treating it as false would silently turn off a default-on flag
 * such as captureContent, which is the SDK's main value.
 */
function bool(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (AFFIRMATIVE.has(value)) return true;
  if (NEGATIVE.has(value)) return false;
  console.warn(
    `[rius] ${name}="${raw}" is not a recognised boolean; using the default (${fallback}). Accepted: 1/true/yes/on, 0/false/no/off.`,
  );
  return fallback;
}

function rate(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

/** Parses a numeric env var; an unparseable value silently falls back to the default. */
function seconds(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
}

/**
 * Clamps a value to [min, max], warning (but never throwing) when it's out of
 * range. NaN and the infinities compare false against both bounds, so they
 * fell through the clamp untouched: `setInterval(fn, NaN)` fires every ~1 ms
 * and `setTimeout(fn, NaN)` fires immediately. Non-finite means "unset".
 */
function clamp(name: string, value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    console.warn(`[rius] ${name}=${value} is not a finite number; using ${fallback}.`);
    return fallback;
  }
  if (value >= min && value <= max) return value;
  const clamped = Math.min(Math.max(value, min), max);
  console.warn(`[rius] ${name}=${value} is outside [${min}, ${max}]; clamped to ${clamped}.`);
  return clamped;
}

/**
 * `service.version` as `OTEL_RESOURCE_ATTRIBUTES` carries it, or undefined.
 *
 * Parsed here by hand because, unlike Python, the JS SDK never reads that
 * variable on this path: `Resource.create` merges the OTel env detector in
 * Python, whereas `NodeTracerProvider` takes `options.resource ??
 * defaultResource()` and `resourceFromAttributes` merges nothing — so an
 * explicit resource, which is what client.ts builds, shuts the variable out
 * entirely. Only `service.version` is read, and only as the last tier: pulling
 * the whole detector in would also let the variable rewrite `service.name` and
 * the agent name, which resolve through their own precedence rules above.
 *
 * The format is the spec's: comma-separated `key=value` pairs, values
 * percent-encoded. A malformed pair is skipped rather than thrown on — a
 * broken environment variable must not stop a process from starting.
 */
function serviceVersionFromOtelEnv(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  for (const pair of raw.split(",")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== "service.version") continue;
    const value = pair.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value) || undefined;
    } catch {
      return value || undefined;
    }
  }
  return undefined;
}

/**
 * Explicit options win, then RIUS_* environment variables, then defaults.
 * GLASSFLOW_* is deliberately not read: this package never shipped under it.
 */
export function resolveConfig(options: RiusOptions = {}, env: Env = process.env): ResolvedConfig {
  const endpoint = (options.endpoint ?? env.RIUS_ENDPOINT ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const serviceName = options.serviceName ?? env.RIUS_SERVICE_NAME ?? DEFAULT_SERVICE_NAME;

  const heartbeatIntervalSeconds = clamp(
    "heartbeatInterval",
    options.heartbeatInterval ?? seconds(env.RIUS_HEARTBEAT_INTERVAL, DEFAULT_HEARTBEAT_INTERVAL),
    HEARTBEAT_INTERVAL_MIN,
    HEARTBEAT_INTERVAL_MAX,
    DEFAULT_HEARTBEAT_INTERVAL,
  );
  const partialSpansDelaySeconds = clamp(
    "partialSpansDelay",
    options.partialSpansDelay ?? seconds(env.RIUS_PARTIAL_SPANS_DELAY, DEFAULT_PARTIAL_SPANS_DELAY),
    PARTIAL_SPANS_DELAY_MIN,
    PARTIAL_SPANS_DELAY_MAX,
    DEFAULT_PARTIAL_SPANS_DELAY,
  );

  return {
    endpoint,
    apiKey: options.apiKey ?? env.RIUS_API_KEY,
    serviceName,
    // Empty is unset, as it is for the agent name and the session id: a blank
    // version would stamp `service.version=""` on every span, which reads as
    // a real (and wrong) answer rather than as no answer. Falls through to
    // the OTel environment last, and to nothing after that.
    serviceVersion:
      options.serviceVersion ||
      env.RIUS_SERVICE_VERSION ||
      serviceVersionFromOtelEnv(env.OTEL_RESOURCE_ATTRIBUTES) ||
      undefined,
    disabled: options.disabled ?? bool("RIUS_DISABLED", env.RIUS_DISABLED, false),
    sampleRate: options.sampleRate ?? rate(env.RIUS_SAMPLE_RATE, 1.0),
    captureContent:
      options.captureContent ?? bool("RIUS_CAPTURE_CONTENT", env.RIUS_CAPTURE_CONTENT, true),
    mask: options.mask,
    heartbeat: options.heartbeat ?? bool("RIUS_HEARTBEAT", env.RIUS_HEARTBEAT, true),
    heartbeatIntervalMs: heartbeatIntervalSeconds * 1000,
    heartbeatEndpoint: `${endpoint}/v1/heartbeat`,
    // Empty falls through to serviceName rather than shipping a blank identity
    // on every heartbeat payload, so `??` would be wrong here.
    agentName: options.agentName || env.RIUS_AGENT_NAME || serviceName,
    partialSpans: options.partialSpans ?? bool("RIUS_PARTIAL_SPANS", env.RIUS_PARTIAL_SPANS, false),
    partialSpansDelayMs: partialSpansDelaySeconds * 1000,
    // Empty is unset, like agentName: a blank session id would group every
    // span under the meaningless session "".
    sessionId: options.sessionId || env.RIUS_SESSION_ID || undefined,
  };
}
