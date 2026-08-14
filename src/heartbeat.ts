import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * Agent-lifetime heartbeat sender (payload v1).
 *
 * The heartbeat answers one question traces cannot: is this agent process
 * alive right now? Spans export only when they finish, so an idle or crashed
 * agent is indistinguishable from a healthy quiet one. The heartbeat is a
 * process-lifetime signal, fully independent of trace traffic: a timer pings
 * `POST /v1/heartbeat` from the caller's `start()` until it calls `stop()`.
 *
 * Contract highlights, ported from the Python SDK's `heartbeat.py` (the spec
 * is normative there; this module keeps parity minus what Node has no
 * equivalent for):
 *
 * - First ping immediately at start (the agent appears without waiting an
 *   interval), then every `intervalMs`.
 * - `stop()` sends a final `stopped: true` ping. `false` is never sent; the
 *   field is present only on that last ping.
 * - Never throws into user code. Pings have a short timeout, are never
 *   retried or queued (liveness is only true fresh; a late heartbeat is
 *   misinformation), and delivery problems warn once per sender.
 * - No fork handling and no process-exit hook: Node has no equivalent to
 *   `os.register_at_fork`/`atexit`, so the caller owns start/stop lifecycle.
 */

const PAYLOAD_VERSION = 1;
const OPEN_TRACES_CAP = 32;
const DEFAULT_PING_TIMEOUT_MS = 3000;
// The final ping must never hold the caller's shutdown hostage, so it gets a
// tighter budget than regular pings: a missed stopped ping just reports as
// gone instead of stopped, which is acceptable.
const DEFAULT_FINAL_PING_TIMEOUT_MS = 1000;

/**
 * Resolved once at module load, the same way the OTLP exporter's user-agent
 * reads its own version: `package.json` is one directory up from both
 * `src/heartbeat.ts` (during tests) and the bundled `dist/*.js` (at runtime).
 */
const SDK_VERSION: string = (() => {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/**
 * Tracks trace ids of currently-open root spans.
 *
 * A root span is one started with no parent context; children of the same
 * trace never touch the set. This is what lets the backend derive
 * `running` vs `ready` from the heartbeat payload alone.
 */
export class OpenRootSpanTracker implements SpanProcessor {
  // trace id (32-hex) -> count of open root spans in that trace. A trace id
  // normally has one root, but the count guards against duplicates.
  private readonly open = new Map<string, number>();

  onStart(span: Span, _parentContext: Context): void {
    if (span.parentSpanContext !== undefined) return;
    const traceId = span.spanContext().traceId;
    this.open.set(traceId, (this.open.get(traceId) ?? 0) + 1);
  }

  onEnd(span: ReadableSpan): void {
    if (span.parentSpanContext !== undefined) return;
    const traceId = span.spanContext().traceId;
    const count = (this.open.get(traceId) ?? 0) - 1;
    if (count <= 0) {
      this.open.delete(traceId);
    } else {
      this.open.set(traceId, count);
    }
  }

  /** Trace ids of currently-open root spans, in the order they opened. */
  openTraceIds(): string[] {
    return [...this.open.keys()];
  }

  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

export type HeartbeatTransport = (
  payload: Record<string, unknown>,
  timeoutMs: number,
) => Promise<void>;

/**
 * Default transport: a plain POST with a per-call timeout, no retries. TLS
 * verification is `fetch`'s default and is deliberately not configurable
 * here: a liveness signal must not become a reason to accept unverified
 * endpoints.
 */
function httpTransport(url: string, headers: Record<string, string>): HeartbeatTransport {
  return async (payload, timeoutMs) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`heartbeat POST ${url} returned ${response.status}`);
    }
  };
}

export interface HeartbeatSenderOptions {
  url: string;
  headers: Record<string, string>;
  intervalMs: number;
  agentName: string;
  tracker: OpenRootSpanTracker;
  /** Injected transport for tests; defaults to the fetch-based HTTP POST above. */
  transport?: HeartbeatTransport;
  pingTimeoutMs?: number;
  finalPingTimeoutMs?: number;
}

/** Pings the heartbeat endpoint for the process lifetime; see module docs for the contract. */
export class HeartbeatSender {
  /** Identity of one process lifetime, fresh per sender. */
  readonly instanceId = randomUUID();

  private readonly agentName: string;
  private readonly tracker: OpenRootSpanTracker;
  private readonly intervalMs: number;
  private readonly pingTimeoutMs: number;
  private readonly finalPingTimeoutMs: number;
  private readonly send: HeartbeatTransport;

  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private deliveryWarned = false;

  constructor(opts: HeartbeatSenderOptions) {
    this.agentName = opts.agentName;
    this.tracker = opts.tracker;
    this.intervalMs = opts.intervalMs;
    this.pingTimeoutMs = opts.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
    this.finalPingTimeoutMs = opts.finalPingTimeoutMs ?? DEFAULT_FINAL_PING_TIMEOUT_MS;
    this.send = opts.transport ?? httpTransport(opts.url, opts.headers);
  }

  /** Starts pinging: an immediate first ping, then every `intervalMs`. */
  start(): void {
    void this.ping(this.pingTimeoutMs, false);
    const timer = setInterval(() => void this.ping(this.pingTimeoutMs, false), this.intervalMs);
    // A live timer would otherwise hold the process open; a heartbeat is not
    // a reason to keep it running.
    if (typeof timer.unref === "function") timer.unref();
    this.timer = timer;
  }

  /** Stops the interval and sends the final `stopped: true` ping. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.ping(this.finalPingTimeoutMs, true);
  }

  private buildPayload(stopped: boolean): Record<string, unknown> {
    const openIds = this.tracker.openTraceIds();
    const payload: Record<string, unknown> = {
      v: PAYLOAD_VERSION,
      instance_id: this.instanceId,
      agent_name: this.agentName,
      // RFC3339 UTC with millisecond precision and a Z suffix, already.
      sent_at: new Date().toISOString(),
      sdk_language: "typescript",
      sdk_version: SDK_VERSION,
      open_traces: openIds.slice(0, OPEN_TRACES_CAP),
      open_trace_count: openIds.length,
    };
    // Present-and-true only on the final ping; false is never sent.
    if (stopped) payload.stopped = true;
    return payload;
  }

  private async ping(timeoutMs: number, stopped: boolean): Promise<void> {
    try {
      await this.send(this.buildPayload(stopped), timeoutMs);
    } catch (error) {
      if (!this.deliveryWarned) {
        this.deliveryWarned = true;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[rius] heartbeat delivery failed (${message}); further failures are silent.`);
      }
    }
  }
}
