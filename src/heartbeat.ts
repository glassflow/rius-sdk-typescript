import { createHash, randomBytes } from "node:crypto";
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SDK_VERSION } from "./version.js";

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
 * - The instance id is derived from a per-instance secret
 *   (`mintInstanceIdentity`), and every ping carries that secret in the
 *   `Rius-Instance-Secret` header. The receiver checks the derivation, so
 *   another holder of the same workspace key cannot speak for this instance.
 *   The secret is never stored or logged.
 * - No fork handling: Node has no equivalent to `os.register_at_fork`, and
 *   this module installs no exit hook of its own; the caller owns the
 *   start/stop lifecycle. `init()` is that caller: it stops the sender on
 *   `shutdown()` and on Node's `beforeExit`, the nearest thing to `atexit`.
 *   `beforeExit` fires when the event loop drains, not on `process.exit()` or
 *   a fatal signal, so a process ended that way sends no stopped ping and
 *   reports as gone once its pings stop.
 */

const PAYLOAD_VERSION = 1;
const OPEN_TRACES_CAP = 32;
const DEFAULT_PING_TIMEOUT_MS = 3000;
// The final ping must never hold the caller's shutdown hostage, so it gets a
// tighter budget than regular pings: a missed stopped ping just reports as
// gone instead of stopped, which is acceptable.
const DEFAULT_FINAL_PING_TIMEOUT_MS = 1000;

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

/** Header carrying the per-instance secret; the receiver accepts 32 to 64 bytes of unpadded base64url. */
export const INSTANCE_SECRET_HEADER = "rius-instance-secret";
const INSTANCE_SECRET_BYTES = 32;

/**
 * The instance id a secret certifies: the first 16 bytes of its SHA-256 as a
 * version 8 UUID. Must match the receiver's derivation byte for byte; the
 * shared test vector pins it.
 */
export function deriveInstanceId(secret: Uint8Array): string {
  const b = createHash("sha256").update(secret).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x80; // version 8
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 9562 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * A fresh instance identity: 32 random bytes (unpadded base64url, as sent in
 * the header) and the id derived from them. Holding the secret is what lets
 * this process, and only this process, ping as that id.
 */
export function mintInstanceIdentity(): { instanceId: string; secret: string } {
  const raw = randomBytes(INSTANCE_SECRET_BYTES);
  return { instanceId: deriveInstanceId(raw), secret: raw.toString("base64url") };
}

/** A non-2xx heartbeat response, with its status for the sender's warnings. */
class HeartbeatHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Default transport: a plain POST with a per-call timeout, no retries. TLS
 * verification is `fetch`'s default and is deliberately not configurable
 * here: a liveness signal must not become a reason to accept unverified
 * endpoints.
 */
function httpTransport(
  url: string,
  headers: Record<string, string>,
  secret: string | undefined,
): HeartbeatTransport {
  return async (payload, timeoutMs) => {
    const response = await fetch(url, {
      method: "POST",
      // The body is JSON whatever the caller's headers say, and the secret
      // is ours. A caller header with either name is dropped in any case:
      // fetch would otherwise merge both values into one.
      headers: {
        ...Object.fromEntries(
          Object.entries(headers).filter(([name]) => {
            const lower = name.toLowerCase();
            return lower !== "content-type" && lower !== INSTANCE_SECRET_HEADER;
          }),
        ),
        "content-type": "application/json",
        ...(secret === undefined ? {} : { [INSTANCE_SECRET_HEADER]: secret }),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The body is ignored by contract, but it must still be released: an
    // unconsumed body holds its socket, and a process pinging every interval
    // for its whole lifetime would retain one per ping on the Node versions
    // whose fetch keeps connections alive that way.
    await response.body?.cancel().catch(() => {});
    if (!response.ok) {
      throw new HeartbeatHttpError(
        `heartbeat POST ${url} returned ${response.status}`,
        response.status,
      );
    }
  };
}

export interface HeartbeatSenderOptions {
  url: string;
  headers: Record<string, string>;
  intervalMs: number;
  agentName: string;
  /**
   * Identity of one process lifetime, injected by init(): the same value
   * rides every span as the `service.instance.id` resource attribute, which
   * is what lets the backend join heartbeats to traces.
   */
  instanceId: string;
  /**
   * The secret `instanceId` was derived from (see `mintInstanceIdentity`),
   * sent in a header on every ping. Absent, no header is sent, which the
   * receiver accepts only for ids that are not derived.
   */
  instanceSecret?: string;
  tracker: OpenRootSpanTracker;
  /** Injected transport for tests; defaults to the fetch-based HTTP POST above. */
  transport?: HeartbeatTransport;
  pingTimeoutMs?: number;
  finalPingTimeoutMs?: number;
  /**
   * Cumulative count of spans whose local parent came from another in-process
   * tracer provider Rius does not receive. Read at every ping;
   * omitted from the payload entirely when not supplied.
   */
  foreignParentSpans?: () => number;
}

/** Pings the heartbeat endpoint for the process lifetime; see module docs for the contract. */
export class HeartbeatSender {
  /** Identity of one process lifetime; injected, shared with span resources. */
  readonly instanceId: string;

  private readonly agentName: string;
  private readonly tracker: OpenRootSpanTracker;
  private readonly intervalMs: number;
  private readonly pingTimeoutMs: number;
  private readonly finalPingTimeoutMs: number;
  private readonly send: HeartbeatTransport;
  private readonly foreignParentSpans?: () => number;

  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private deliveryWarned = false;
  private refusalWarned = false;

  constructor(opts: HeartbeatSenderOptions) {
    this.instanceId = opts.instanceId;
    this.agentName = opts.agentName;
    this.tracker = opts.tracker;
    this.intervalMs = opts.intervalMs;
    this.pingTimeoutMs = opts.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
    this.finalPingTimeoutMs = opts.finalPingTimeoutMs ?? DEFAULT_FINAL_PING_TIMEOUT_MS;
    // The secret never leaves the transport closure: not persisted, logged or
    // put in the payload.
    this.send = opts.transport ?? httpTransport(opts.url, opts.headers, opts.instanceSecret);
    this.foreignParentSpans = opts.foreignParentSpans;
  }

  /** Starts pinging: an immediate first ping, then every `intervalMs`. */
  start(): void {
    // Idempotent, like stop(): a second start() used to overwrite the timer
    // handle and leak the first interval past stop().
    if (this.timer !== undefined) return;
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
    // Cumulative for this instance, not a delta: a backend that misses a ping
    // still sees the total. Sent whether or not the backend reads it yet: it
    // costs nothing, and the count is there from the first ping once it does.
    if (this.foreignParentSpans !== undefined) {
      payload.foreign_parent_spans = this.foreignParentSpans();
    }
    // Present-and-true only on the final ping; false is never sent.
    if (stopped) payload.stopped = true;
    return payload;
  }

  private async ping(timeoutMs: number, stopped: boolean): Promise<void> {
    try {
      await this.send(this.buildPayload(stopped), timeoutMs);
    } catch (error) {
      if (error instanceof HeartbeatHttpError && error.status === 403) {
        // The one refusal a user can act on: something rewrote the instance
        // id or the secret header between the SDK and the receiver.
        if (!this.refusalWarned) {
          this.refusalWarned = true;
          console.warn(
            `[rius] heartbeat refused (403): the receiver did not accept this instance secret for instance_id ${this.instanceId}; check that nothing overrides the instance id or strips the ${INSTANCE_SECRET_HEADER} header.`,
          );
        }
        return;
      }
      if (!this.deliveryWarned) {
        this.deliveryWarned = true;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[rius] heartbeat delivery failed (${message}); further failures are silent.`);
      }
    }
  }
}
