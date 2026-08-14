export const DEFAULT_ENDPOINT = "https://ingest.eu.console.rius-glassflow.com";
const DEFAULT_SERVICE_NAME = "unknown_service";

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
  disabled?: boolean;
  sampleRate?: number;
  captureContent?: boolean;
  mask?: Mask;
}

export interface ResolvedConfig {
  endpoint: string;
  apiKey?: string;
  serviceName: string;
  disabled: boolean;
  sampleRate: number;
  captureContent: boolean;
  mask?: Mask;
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

/**
 * Explicit options win, then RIUS_* environment variables, then defaults.
 * GLASSFLOW_* is deliberately not read: this package never shipped under it.
 */
export function resolveConfig(options: RiusOptions = {}, env: Env = process.env): ResolvedConfig {
  const endpoint = (options.endpoint ?? env.RIUS_ENDPOINT ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  return {
    endpoint,
    apiKey: options.apiKey ?? env.RIUS_API_KEY,
    serviceName: options.serviceName ?? env.RIUS_SERVICE_NAME ?? DEFAULT_SERVICE_NAME,
    disabled: options.disabled ?? bool("RIUS_DISABLED", env.RIUS_DISABLED, false),
    sampleRate: options.sampleRate ?? rate(env.RIUS_SAMPLE_RATE, 1.0),
    captureContent:
      options.captureContent ?? bool("RIUS_CAPTURE_CONTENT", env.RIUS_CAPTURE_CONTENT, true),
    mask: options.mask,
  };
}
