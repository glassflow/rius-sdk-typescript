export const DEFAULT_ENDPOINT = "https://ingest.eu.console.rius-glassflow.com";
const DEFAULT_SERVICE_NAME = "unknown_service";

/** Redacts content attribute values at export. Receives the key when it accepts one. */
export type Mask = (value: unknown, context?: { key: string }) => unknown;

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

function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
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
    disabled: options.disabled ?? bool(env.RIUS_DISABLED, false),
    sampleRate: options.sampleRate ?? rate(env.RIUS_SAMPLE_RATE, 1.0),
    captureContent: options.captureContent ?? bool(env.RIUS_CAPTURE_CONTENT, true),
    mask: options.mask,
  };
}
