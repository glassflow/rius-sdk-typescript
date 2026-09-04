/**
 * Workspaces: route spans from one process to per-customer destinations.
 *
 * One client, one provider, one batch pipeline; the *destination* is a
 * context-scoped property. `withWorkspace(alias, fn)` sets an OTel context
 * key (exactly like `withSession`), `WorkspaceSpanProcessor` stamps it as a
 * transient attribute at span start, and `RoutingSpanExporter` partitions
 * each export batch by that attribute, strips it, and forwards every
 * partition to the exporter registered for its alias. Spans started outside
 * any scope go to the default destination.
 *
 * Because the alias rides OTel context, everything started in scope routes
 * together: `observe` wrappers, generations, sessions, and spans created by
 * auto-instrumentation. That is the property a second client could never
 * give, which is why this SDK has no scoped-client mode at all.
 *
 * Two rules the design enforces or warns about:
 *
 * - The routing attribute never reaches the wire. The destination's API key
 *   is what tells the backend which workspace a span belongs to; the alias
 *   is process-local configuration, so the exporter strips it before
 *   delegating.
 * - One trace, one workspace. The backend derives the workspace from the API
 *   key per request, so a trace split across scopes would come apart.
 *   Starting a span under a different alias than its parent's logs a
 *   warning; switch workspaces at request boundaries, not inside a trace.
 */
import { type Context, context as apiContext, createContextKey, trace } from "@opentelemetry/api";
import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type {
  ReadableSpan,
  Span,
  SpanExporter,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { WORKSPACE_ROUTE } from "./semconv.js";

const WORKSPACE_KEY = createContextKey("rius-workspace-alias");

export type WorkspaceExporterFactory = (apiKey: string) => SpanExporter;

/**
 * Scope every span started inside `fn` to one workspace destination.
 *
 * `alias` names a workspace registered via `init({ workspaces })` or
 * `registerWorkspace()`; the scope's spans are exported with that
 * workspace's API key. Scopes nest and follow async continuations the way
 * all OTel context does, but a trace must stay inside one workspace: enter
 * the scope at a request boundary, before the root span starts.
 *
 * ```typescript
 * await withWorkspace("acme", async () => {
 *   await handle(request) // every span of the request lands in acme's workspace
 * })
 * ```
 */
export function withWorkspace<T>(alias: string, fn: (alias: string) => T): T {
  if (!alias) throw new Error("workspace alias must be a non-empty string");
  return apiContext.with(apiContext.active().setValue(WORKSPACE_KEY, alias), () => fn(alias));
}

/**
 * Stamps the active workspace alias on every span at start.
 *
 * Stamping happens in `onStart` for the same reason sessions stamp there:
 * pending snapshots are built from start-time attributes, and a snapshot
 * must route to the same workspace its final span will.
 */
export class WorkspaceSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const alias = parentContext.getValue(WORKSPACE_KEY);
    if (typeof alias !== "string") return;
    const parent = trace.getSpan(parentContext);
    const parentAlias = (parent as unknown as ReadableSpan | undefined)?.attributes?.[
      WORKSPACE_ROUTE
    ];
    if (parentAlias !== undefined && parentAlias !== alias) {
      console.warn(
        `[rius] span "${(span as unknown as ReadableSpan).name}" starts under workspace "${alias}" but its parent is stamped "${String(parentAlias)}"; a trace cannot straddle two workspaces (the backend derives the workspace from the API key). Switch workspaces at request boundaries, before the root span starts.`,
      );
    }
    span.setAttribute(WORKSPACE_ROUTE, alias);
  }

  onEnd(_span: ReadableSpan): void {}

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

/**
 * Partition each batch by the routing attribute and fan out.
 *
 * Wraps the default exporter plus one lazily-created exporter per registered
 * workspace key. Sits innermost in the export chain, so masking and
 * export-health wrap the whole fan-out. Spans with no stamp go to the
 * default destination; a stamp whose alias is not registered also goes to
 * the default (the vendor's own workspace) with a warning, which keeps the
 * data rather than dropping it and cannot leak one customer's spans to
 * another.
 */
export class RoutingSpanExporter implements SpanExporter {
  private readonly routes: Map<string, string>;
  private readonly exporters = new Map<string, SpanExporter>();
  private readonly warnedAliases = new Set<string>();

  constructor(
    private readonly defaultExporter: SpanExporter,
    private readonly factory: WorkspaceExporterFactory,
    routes: Record<string, string> = {},
  ) {
    this.routes = new Map(Object.entries(routes));
  }

  /** Add or replace a route. Replacing supports key rotation. */
  register(alias: string, apiKey: string): void {
    if (!alias || !apiKey) {
      throw new Error("workspace alias and apiKey must be non-empty strings");
    }
    this.routes.set(alias, apiKey);
    this.warnedAliases.delete(alias);
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const groups = new Map<SpanExporter, ReadableSpan[]>();
    for (const span of spans) {
      const attributes = span.attributes as Record<string, unknown>;
      const raw = attributes[WORKSPACE_ROUTE];
      let destination = this.defaultExporter;
      if (raw !== undefined) {
        // The attribute is process-local routing state, never wire data.
        // In-place removal matches MaskingSpanExporter's discipline here:
        // this exporter is the last consumer of the span object.
        delete attributes[WORKSPACE_ROUTE];
        destination = this.resolve(String(raw));
      }
      const group = groups.get(destination);
      if (group === undefined) groups.set(destination, [span]);
      else group.push(span);
    }

    let pending = groups.size;
    if (pending === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    let failed: ExportResult | undefined;
    for (const [exporter, group] of groups) {
      exporter.export(group, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) failed = result;
        pending -= 1;
        if (pending === 0) resultCallback(failed ?? { code: ExportResultCode.SUCCESS });
      });
    }
  }

  private resolve(alias: string): SpanExporter {
    const apiKey = this.routes.get(alias);
    if (apiKey === undefined) {
      if (!this.warnedAliases.has(alias)) {
        this.warnedAliases.add(alias);
        console.warn(
          `[rius] no workspace registered for alias "${alias}"; its spans go to the default destination. Register it with registerWorkspace("${alias}", apiKey) or in init({ workspaces }).`,
        );
      }
      return this.defaultExporter;
    }
    let exporter = this.exporters.get(apiKey);
    if (exporter === undefined) {
      exporter = this.factory(apiKey);
      this.exporters.set(apiKey, exporter);
    }
    return exporter;
  }

  async forceFlush(): Promise<void> {
    await this.defaultExporter.forceFlush?.();
    await Promise.all([...this.exporters.values()].map((e) => e.forceFlush?.()));
  }

  async shutdown(): Promise<void> {
    await this.defaultExporter.shutdown();
    await Promise.all([...this.exporters.values()].map((e) => e.shutdown()));
  }
}

/** The routing exporter of the active global client, when routing is enabled. */
let globalRouting: RoutingSpanExporter | undefined;

/** @internal Wired by init()/shutdown(); not part of the public API. */
export function setGlobalRouting(routing: RoutingSpanExporter | undefined): void {
  globalRouting = routing;
}

/**
 * Add (or rotate the key of) a workspace destination on the global client.
 *
 * Requires `init({ workspaces })` to have opted into routing (an empty
 * object opts in with no static routes). Spans started inside
 * `withWorkspace(alias, ...)` are then exported with `apiKey`.
 */
export function registerWorkspace(alias: string, apiKey: string): void {
  if (globalRouting === undefined) {
    throw new Error(
      "[rius] workspace routing is not enabled: pass workspaces (an empty object is fine) " +
        "to init() to opt in before registering destinations",
    );
  }
  globalRouting.register(alias, apiKey);
}
