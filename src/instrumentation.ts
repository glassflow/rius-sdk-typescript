import { createRequire } from "node:module";
import { join, sep } from "node:path";
import {
  type Exception,
  type Span,
  SpanStatusCode,
  type TracerProvider,
  trace,
} from "@opentelemetry/api";
import { type Instrumentation, registerInstrumentations } from "@opentelemetry/instrumentation";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { McpClientLike } from "./instrumentationMcp.js";
import { TRACER_NAME } from "./semconv.js";
import { SDK_VERSION } from "./version.js";

/**
 * `"self-applying"` is for an entry whose `load()` has already taken full
 * effect by the time it resolves (e.g. by monkey-patching a prototype)
 * rather than returning something for `enableInstrumentations` to attach.
 * There is nothing to hand to `registerInstrumentations` or a processor
 * sink, so it is a distinct kind rather than a marker on the loaded value:
 * dispatch stays a single switch on `kind`, and the loaded value's shape
 * does not have to double as a signal.
 */
export type EntryKind = "instrumentation" | "processor" | "self-applying";

export interface RegistryEntry {
  name: string;
  kind: EntryKind;
  /**
   * Where a `processor` entry goes in the sink. `"first"` for a processor that
   * must see a span before the exporting processor queues it. Ignored by
   * `instrumentation` and `self-applying` entries. Defaults to `"last"`.
   */
  insert?: "first" | "last";
  /**
   * Resolves undefined when the optional package is not installed.
   * For a `self-applying` entry, resolving to anything other than undefined
   * both means "installed" and confirms the patch already ran.
   *
   * Receives the tracer provider for entries that must hand a tracer to a
   * third-party registration API themselves (the Vercel AI SDK v7's
   * `registerTelemetry`); conventional instrumentations ignore it and are
   * bound by `enableInstrumentations` instead.
   *
   * `teardown` collects whatever undoes the entry's side effects, so
   * `shutdown()` can leave the process as it found it and a later `init()`
   * patches afresh. Self-applying entries push their uninstall functions
   * here; conventional instrumentations are disabled by
   * `enableInstrumentations` and need not.
   */
  load(tracerProvider?: TracerProvider, teardown?: Array<() => void>): Promise<unknown | undefined>;
}

/**
 * Anything that accepts a span processor after the fact. The provider itself is
 * not usable here: OpenTelemetry JS 2.x accepts `spanProcessors` at provider
 * construction only and has no `addSpanProcessor`, so `init()` passes its
 * delegating processor instead.
 */
export interface ProcessorSink {
  add(processor: SpanProcessor): void;
  addFirst(processor: SpanProcessor): void;
}

// esbuild rewrites a bare `import()` into `require()` in the CJS build, and
// @arizeai/openinference-vercel is ESM-only (type: module, no require
// condition), so a rewritten call throws ERR_PACKAGE_PATH_NOT_EXPORTED and the
// integration would silently vanish for every CommonJS consumer. Building the
// function at runtime keeps a real dynamic import in both output formats.
//
// Do not "simplify" this to a literal import(): it is the only thing keeping the
// ESM-only integrations working for CommonJS consumers.
const dynamicImport = new Function("s", "return import(s)") as (
  s: string,
) => Promise<Record<string, unknown>>;

/** The installable package a specifier belongs to: `@scope/name`, or `name`. */
function packageOf(specifier: string): string {
  const segments = specifier.split("/");
  const take = specifier.startsWith("@") ? 2 : 1;
  return segments.slice(0, take).join("/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether an error means "the specifier did not resolve" for that specifier.
 *
 * @internal Exported for tests. Not re-exported from the package entry point.
 */
export function isUnresolved(error: unknown, specifier: string): boolean {
  // Anything can be thrown, including null and primitives, so read the message
  // defensively: this runs inside the error path and must not throw itself.
  if (typeof error !== "object" || error === null) return false;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return false;

  // Matched immediately after the loader's resolution phrase, so a failure to
  // resolve one of the package's OWN dependencies is not mistaken for the
  // package being absent: those messages name the missing dependency, and
  // mention our specifier only as the importer's path, if at all. Codes are not
  // enough on their own; loaders disagree, and some report no code.
  //
  // Either the full specifier or just its package: importing a subpath such as
  // "<pkg>/utils" fails with a message naming only "<pkg>", so requiring the
  // full specifier would classify a plainly absent optional peer as installed
  // and warn every consumer who skipped it.
  //
  // The trailing boundary is what keeps the package alternative honest: without
  // it, "<pkg>" would match "<pkg>-nope", laundering a missing sibling package
  // back into the quiet path.
  const alternatives = [specifier, packageOf(specifier)].map(escapeRegExp).join("|");
  return new RegExp(
    `(?:cannot find (?:module|package)|could not resolve|failed to load url)\\s*['"\`]?(?:${alternatives})['"\`]?(?![\\w./@-])`,
    "i",
  ).test(message);
}

async function optional(specifier: string): Promise<Record<string, unknown> | undefined> {
  try {
    return await dynamicImport(specifier);
  } catch (error) {
    if (isUnresolved(error, specifier)) return undefined;

    // Sandboxed module runners (a vm context with no import callback) reject
    // dynamic import from a runtime-built function, so retry through the
    // loader's own import. NOTE: esbuild rewrites this literal import() to
    // require() in the CJS bundle. That is tolerable only because this branch is
    // unreachable in a normal Node process; the path above is the one shipped
    // consumers execute, and it must stay.
    if ((error as { code?: string }).code === "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING") {
      try {
        return (await import(specifier)) as Record<string, unknown>;
      } catch (fallbackError) {
        if (isUnresolved(fallbackError, specifier)) return undefined;
        warnBroken(specifier, fallbackError);
        return undefined;
      }
    }

    // The package IS present but failed to load, which must be loud: a silent
    // skip here looks identical to "user did not install it".
    warnBroken(specifier, error);
    return undefined;
  }
}

/**
 * The single warn path for "present but broken". `subject` is a module specifier
 * when an import failed and an entry name when enabling one failed. Accepts an
 * unknown throwable and never throws itself, so it is safe on any error path.
 */
function warnBroken(subject: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[rius] integration "${subject}" is installed but failed to load: ${message}`);
}

interface ManuallyInstrumentable {
  manuallyInstrument(module: object): void;
}

/**
 * The main CJS exports of `pkg` if this process has already `require`d it,
 * mapped through `toPatchable`. Found by scanning `require.cache` rather than
 * resolving the package from here: resolution from inside this SDK can fail
 * under isolated installs (pnpm) for a package we do not declare, while the
 * cache is process-global and keyed by absolute path. `toPatchable` doubles as
 * the shape test that picks the package's main exports out of its internal
 * files.
 *
 * @internal Exported for tests. Not re-exported from the package entry point.
 */
export function cachedCjsExports(
  pkg: string,
  toPatchable: (exports: Record<string, unknown>) => object | undefined,
): object | undefined {
  let cache: Record<string, { exports?: unknown } | undefined>;
  try {
    // Any base file path gives the same process-global cache; the base only
    // matters for resolution, which this deliberately never does.
    cache = createRequire(join(process.cwd(), "noop.js")).cache;
  } catch {
    return undefined;
  }
  if (cache === undefined || cache === null) return undefined;

  const needle = `${sep}node_modules${sep}${pkg.split("/").join(sep)}${sep}`;
  for (const key of Object.keys(cache)) {
    if (!key.includes(needle)) continue;
    const exports = cache[key]?.exports;
    if (typeof exports !== "object" || exports === null) continue;
    const patchable = toPatchable(exports as Record<string, unknown>);
    if (patchable !== undefined) return patchable;
  }
  return undefined;
}

/**
 * Patch the build of a dual-package provider SDK that this process is actually
 * using. `openai` and `@anthropic-ai/sdk` ship separate CJS and ESM builds
 * with separate class objects, and the OpenInference require hook only ever
 * sees the CJS one, so a pure-ESM app would silently get no spans:
 *
 * - CJS build already in `require.cache` → the app requires it, patch that
 *   copy. This also covers a require that happened BEFORE init(), which the
 *   require hook alone never repairs.
 * - Otherwise → import the ESM build and patch it. In an ESM app every static
 *   import already ran before init(), so this is the copy in use.
 *
 * Picking one build used to be forced on us: `patch()` was guarded by a
 * module-global flag (github.com/Arize-ai/openinference/issues/3557) that let
 * only ONE build be patched per process, so a CJS app whose only require came
 * after init() got the ESM build patched and nothing else. That flag is now
 * scoped to the patched class (instrumentation-anthropic >= 0.2.1,
 * -openai >= 4.2.1, the floor package.json pins), so the require hook can
 * still patch a later CJS require on top of whatever we patched here — the
 * case above is covered without this function choosing differently.
 *
 * What remains uncovered is narrower: a HYBRID app that has already loaded
 * both builds before init(). The cached CJS copy wins here and the ESM one
 * goes unpatched. Patching both is now permitted and would close it, at the
 * cost of importing a build the app may never use.
 *
 * The patchable is a plain-object wrapper, never the ESM namespace itself:
 * `patch()` writes an `openInferencePatched` marker onto what it receives, and
 * a frozen ESM namespace would throw on that write.
 *
 * Prototype patching needs no import-order cooperation from the app — clients
 * constructed before init() share the same prototype and are covered too.
 */
/** @internal Exported for tests. Not re-exported from the package entry point. */
export async function patchActiveBuild(
  instrumentation: ManuallyInstrumentable,
  pkg: string,
  toPatchable: (exports: Record<string, unknown>) => object | undefined,
): Promise<void> {
  const cached = cachedCjsExports(pkg, toPatchable);
  if (cached !== undefined) {
    instrumentation.manuallyInstrument(cached);
    return;
  }
  // Provider not installed resolves undefined and stays quiet, matching the
  // registry's loud/quiet split: the missing package here is the PROVIDER, not
  // the instrumentation the user installed.
  const ns = await optional(pkg);
  if (ns === undefined) return;
  const patchable = toPatchable(ns);
  if (patchable === undefined) {
    // The provider IS present but its exports are not a shape the OpenInference
    // patch can wrap (say, a future major restructured the class). Loud, for
    // the same reason a throwing load() is: the entry still reports itself
    // enabled, and "enabled but silently unpatched" is the failure this whole
    // change exists to eliminate.
    warnBroken(pkg, new Error("unrecognised module shape, instrumentation not applied"));
    return;
  }
  instrumentation.manuallyInstrument(patchable);
}

/**
 * Shape tests for the provider exports, returning what each OpenInference
 * `patch()` expects to receive. Checking down to the method being wrapped
 * keeps `cachedCjsExports` from picking an internal file of the package.
 *
 * @internal Exported for tests. Not re-exported from the package entry point.
 */
export function openaiPatchable(exports: Record<string, unknown>): object | undefined {
  const cls = (exports.OpenAI ?? exports.default) as
    | { Chat?: { Completions?: { prototype?: { create?: unknown } } } }
    | undefined;
  return cls?.Chat?.Completions?.prototype?.create ? { OpenAI: cls } : undefined;
}

/** @internal Exported for tests. Not re-exported from the package entry point. */
export function anthropicPatchable(exports: Record<string, unknown>): object | undefined {
  const cls = (exports.default ?? exports.Anthropic) as
    | { Messages?: { prototype?: { create?: unknown } } }
    | undefined;
  return cls?.Messages?.prototype?.create ? { default: cls } : undefined;
}

/**
 * The OpenAI methods the OpenInference instrumentation wraps, as paths from
 * the `OpenAI` class to the resource whose prototype carries `create`.
 * `Responses` is absent from older provider builds and skipped there, as the
 * instrumentation itself does.
 */
const OPENAI_INSTRUMENTED_RESOURCES: readonly (readonly string[])[] = [
  ["Chat", "Completions"],
  ["Completions"],
  ["Embeddings"],
  ["Responses"],
];

/** Marks a guard wrapper and remembers the method it wraps. */
const GUARDED_ORIGINAL = Symbol("rius.openai.guardedOriginal");

type Method = ((...args: unknown[]) => unknown) & { [GUARDED_ORIGINAL]?: Method };

function openaiPrototypes(moduleExports: unknown): Array<Record<string, unknown>> {
  const cls = (moduleExports as { OpenAI?: unknown } | undefined)?.OpenAI;
  const prototypes: Array<Record<string, unknown>> = [];
  for (const path of OPENAI_INSTRUMENTED_RESOURCES) {
    let resource: unknown = cls;
    for (const segment of path) {
      resource = (resource as Record<string, unknown> | undefined)?.[segment];
    }
    const proto = (resource as { prototype?: Record<string, unknown> } | undefined)?.prototype;
    if (typeof proto?.create === "function") prototypes.push(proto);
  }
  return prototypes;
}

/**
 * The promise that settles when the HTTP exchange does, WITHOUT parsing the
 * body. The provider's `APIPromise` parses lazily on its first `then`. When the
 * instrumentation recognises it as the `APIPromise` class it imported itself
 * (the app uses the same build, as an ESM app does), it chains through
 * `_thenUnwrap`, which parses AGAIN from the raw response, so observing the
 * `APIPromise` itself would read the body twice and fail every successful
 * call. `responsePromise` rejects with the provider's status error
 * (404, 429, 500 …), a connection error, a timeout or an abort. A plain promise
 * (a build without `APIPromise`) has no lazy parse and is observed as is.
 */
function settlementOf(result: unknown): PromiseLike<unknown> | undefined {
  const raw = (result as { responsePromise?: unknown } | null | undefined)?.responsePromise;
  if (typeof (raw as PromiseLike<unknown> | undefined)?.then === "function") {
    return raw as PromiseLike<unknown>;
  }
  return result instanceof Promise ? result : undefined;
}

/** Ends `span` the way the instrumentation ends it on a synchronous throw. */
function failSpan(span: Span, error: unknown): void {
  // The instrumentation may have ended it already (a throw it did handle).
  if (!span.isRecording()) return;
  span.recordException(error instanceof Error ? error : (String(error) as Exception));
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
  span.end();
}

/**
 * Wrap one provider method BENEATH the instrumentation's own patch, so the
 * instrumentation's wrapper calls this one as its `original`. It runs inside
 * the instrumentation's `context.with(trace.setSpan(..., span))`, which makes
 * the active span the instrumentation's LLM span, not the caller's. On a
 * rejection it ends that span as the instrumentation would have. The value
 * returned to the instrumentation, and through it to the caller, is the
 * provider's own, unchanged.
 */
function guardRejections(original: Method): Method {
  const guarded: Method = function (this: unknown, ...args: unknown[]): unknown {
    const span = trace.getActiveSpan();
    const result = original.apply(this, args);
    if (span?.isRecording()) {
      // A derived promise that always settles fulfilled, so observing the
      // rejection never produces an unhandled one of its own; the caller's
      // promise still rejects exactly as before.
      settlementOf(result)?.then(undefined, (error: unknown) => failSpan(span, error));
    }
    return result;
  };
  guarded[GUARDED_ORIGINAL] = original;
  return guarded;
}

interface PatchingInstrumentation extends ManuallyInstrumentable {
  patch(moduleExports: unknown, moduleVersion?: string): unknown;
  unpatch(moduleExports: unknown, moduleVersion?: string): void;
}

/**
 * The OpenInference OpenAI instrumentation, with its rejected calls ended.
 *
 * `@arizeai/openinference-instrumentation-openai` (4.2.1 through 4.2.7) ends
 * its span when `create` resolves or throws synchronously, and nowhere else:
 * `invokeMaybeAPIPromise` passes only an `onfulfilled` handler. A call the
 * provider REJECTS — a 404 for an unknown model, a 429, a timeout — leaves the
 * span open forever, so it is never exported and the trace shows the parent
 * alone, status Ok. The Python instrumentation records the same call as an
 * ERROR span.
 *
 * The subclass overrides `patch`, the one method both the instrumentation's
 * require hook and `manuallyInstrument` go through, so every build it patches
 * gets the guard, the CJS copy a later require brings in included. The guard
 * is installed just before the instrumentation wraps the method and taken off
 * again if it declined to (a module it had already patched), so it only ever
 * sits directly beneath the instrumentation's wrapper. `unpatch` restores the
 * provider's own method once the instrumentation has unwrapped its layer. It
 * does not unwrap `Responses` (an upstream omission), so there the guard stays
 * beneath the instrumentation's leftover wrapper, where it still only ever sees
 * that wrapper's span.
 *
 * Remove once upstream ends the span on rejection.
 */
function withRejectedCallsEnded(
  Base: new () => PatchingInstrumentation,
): new () => PatchingInstrumentation {
  return class extends Base {
    patch(moduleExports: unknown, moduleVersion?: string): unknown {
      const installed: Array<[Record<string, unknown>, Method]> = [];
      for (const proto of openaiPrototypes(moduleExports)) {
        const create = proto.create as Method;
        if (create[GUARDED_ORIGINAL] !== undefined) continue;
        const guarded = guardRejections(create);
        proto.create = guarded;
        installed.push([proto, guarded]);
      }
      const patched = super.patch(moduleExports, moduleVersion);
      // Still on top means the instrumentation did not wrap it: take the guard
      // off, or it would see the CALLER's span as active.
      for (const [proto, guarded] of installed) {
        if (proto.create === guarded) proto.create = guarded[GUARDED_ORIGINAL];
      }
      return patched;
    }

    unpatch(moduleExports: unknown, moduleVersion?: string): void {
      super.unpatch(moduleExports, moduleVersion);
      for (const proto of openaiPrototypes(moduleExports)) {
        const original = (proto.create as Method)[GUARDED_ORIGINAL];
        if (original !== undefined) proto.create = original;
      }
    }
  };
}

/**
 * Shape test for the MCP SDK's client module: picks the exports carrying a
 * `Client` whose prototype has the `callTool` this SDK wraps, so
 * `cachedCjsExports` cannot mistake an internal file for the client module.
 *
 * @internal Exported for tests. Not re-exported from the package entry point.
 */
export function mcpClientPatchable(exports: Record<string, unknown>): object | undefined {
  const cls = exports.Client as McpClientLike | undefined;
  return typeof cls?.prototype?.callTool === "function" ? { Client: cls } : undefined;
}

/**
 * Bundled integrations. Packages are imported lazily so none is a hard
 * dependency; install them as optional peers and init() enables what it finds.
 *
 * Two kinds on purpose: the Vercel AI SDK support is contributed as a SPAN
 * PROCESSOR, while the OpenAI, Anthropic and LangChain support are conventional
 * instrumentations.
 */
// The Vercel AI SDK v7 removed the per-call `experimental_telemetry.tracer`
// hook: spans exist only if something calls its `registerTelemetry()` with an
// integration, and the official OTel integration is @ai-sdk/otel's
// OpenTelemetry class (GenAI-semconv-native spans — gen_ai.input/output
// messages, gen_ai.tool.definitions, usage). Registering it here, bound to our
// tracer, makes a v7 app traced with zero telemetry code — v5 apps keep using
// per-call `experimental_telemetry` and are untouched (their `ai` exports no
// `registerTelemetry`).
//
// The previous registration is remembered and REPLACED on re-init: the AI SDK
// only ever appends to its global integration list, so re-registering without
// removing ours would double every span, and keeping the old one would export
// through a shut-down provider.
let vercelTelemetryIntegration: unknown;

async function registerVercelTelemetry(
  tracerProvider: TracerProvider,
  teardown?: Array<() => void>,
): Promise<boolean> {
  const ai = await optional("ai");
  const register = ai?.registerTelemetry as ((integration: unknown) => void) | undefined;
  if (register === undefined) return false; // ai absent, or v5/v6: nothing to register
  const otel = await optional("@ai-sdk/otel");
  const OpenTelemetryIntegration = otel?.OpenTelemetry as
    | (new (options: { tracer: unknown }) => unknown)
    | undefined;
  if (OpenTelemetryIntegration === undefined) {
    console.warn(
      "[rius] Vercel AI SDK v7+ found, but its spans require the @ai-sdk/otel package, " +
        "which is not installed — `ai` calls will not be traced. " +
        "Install it (npm i @ai-sdk/otel) and rius registers it automatically.",
    );
    return false;
  }
  const bag = globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] };
  if (vercelTelemetryIntegration !== undefined && bag.AI_SDK_TELEMETRY_INTEGRATIONS) {
    bag.AI_SDK_TELEMETRY_INTEGRATIONS = bag.AI_SDK_TELEMETRY_INTEGRATIONS.filter(
      (integration) => integration !== vercelTelemetryIntegration,
    );
  }
  const integration = new OpenTelemetryIntegration({
    tracer: tracerProvider.getTracer(TRACER_NAME, SDK_VERSION),
  });
  vercelTelemetryIntegration = integration;
  register(integration);
  // The AI SDK has no unregister; removing ours from its global list is the
  // only way a shut-down provider stops receiving spans.
  teardown?.push(() => {
    if (bag.AI_SDK_TELEMETRY_INTEGRATIONS) {
      bag.AI_SDK_TELEMETRY_INTEGRATIONS = bag.AI_SDK_TELEMETRY_INTEGRATIONS.filter(
        (candidate) => candidate !== integration,
      );
    }
    if (vercelTelemetryIntegration === integration) vercelTelemetryIntegration = undefined;
  });
  return true;
}

/**
 * The Vercel AI SDK's own operation id. A SOURCE spelling of a dialect this SDK
 * never emits, so it stays here rather than in semconv.ts, the set of keys we
 * write — the same reason normalize.ts spells its dialect sources inline.
 */
const VERCEL_OPERATION_ID = "ai.operationId";

/**
 * Whether a span speaks the Vercel AI SDK's `ai.*` dialect, the one
 * @arizeai/openinference-vercel's transform exists to translate.
 *
 * The transform is not scoped by itself: it also converts ANY `gen_ai.*` span,
 * so run on every span it rewrote native and third-party spans alike —
 * flattened `llm.input_messages.*`, `llm.system`, `llm.token_count.total`,
 * `input/output.mime_type`, the messages duplicated into
 * `input.value`/`output.value`. So it runs only on a span carrying a string
 * `ai.operationId` that starts with `ai.`.
 *
 * That attribute, not the instrumentation scope, because the scope proves
 * nothing either way. AI SDK v5/v6 default to a tracer named `ai` but take
 * whatever tracer the caller passes in `experimental_telemetry.tracer`, and
 * the v7 integration registered above is bound to OUR tracer. Every v5/v6 span
 * sets `ai.operationId` (their `assembleOperationName`, on all of
 * `ai.generateText`, `.doGenerate`, `ai.streamText`, `ai.toolCall`, `ai.embed`,
 * `ai.rerank` and the rest), as does @ai-sdk/otel's `LegacyOpenTelemetry`, the
 * v7 integration that still emits that dialect. `operation.name` is not used:
 * it is a display label any producer may set. @ai-sdk/otel's `OpenTelemetry`
 * integration, the one this SDK registers for v7, never sets
 * `ai.operationId`: its spans are GenAI-native, the normalizer already derives
 * their taxonomy from `gen_ai.operation.name`, and the transform would only
 * duplicate them.
 */
export function isVercelDialectSpan(span: ReadableSpan): boolean {
  const operationId = span.attributes[VERCEL_OPERATION_ID];
  return typeof operationId === "string" && operationId.startsWith("ai.");
}

export const REGISTRY: RegistryEntry[] = [
  {
    name: "vercel-ai",
    kind: "processor",
    // The transform can ADD content attributes such as input.value. Masking
    // runs in the exporter chain, which executes after a span is queued, so the
    // transform has to run before the exporting processor sees the span or the
    // attributes it added would never be sanitised.
    insert: "first",
    async load(tracerProvider?: TracerProvider, teardown?: Array<() => void>) {
      // ai v7: span creation itself must be registered (see
      // registerVercelTelemetry above). Done before the transform lookup, so a
      // v7 app without @arizeai/openinference-vercel is still traced — its
      // spans are GenAI-native and need no translation.
      const registered =
        tracerProvider === undefined
          ? false
          : await registerVercelTelemetry(tracerProvider, teardown);

      // Deliberately NOT the package's own OpenInferenceBatchSpanProcessor /
      // OpenInferenceSimpleSpanProcessor: both require an exporter and export
      // through it, so adding one alongside our exporting processor would send
      // every span twice, once raw and once transformed. Only the attribute
      // transform is wanted, wrapped in a processor of ours that never exports.
      const utils = await optional("@arizeai/openinference-vercel/utils");
      const add = utils?.addOpenInferenceAttributesToSpan as
        | ((span: ReadableSpan) => void)
        | undefined;
      if (add === undefined && !registered) return undefined;
      return {
        onStart() {},
        onEnd(span: ReadableSpan) {
          if (add !== undefined && isVercelDialectSpan(span)) add(span);
        },
        async forceFlush() {},
        async shutdown() {},
      } satisfies SpanProcessor;
    },
  },
  {
    name: "openai",
    kind: "instrumentation",
    async load() {
      const mod = await optional("@arizeai/openinference-instrumentation-openai");
      const Ctor = mod?.OpenAIInstrumentation as (new () => PatchingInstrumentation) | undefined;
      if (Ctor === undefined) return undefined;
      // Subclassed so a rejected call still ends its span; see
      // withRejectedCallsEnded.
      const instrumentation = new (withRejectedCallsEnded(Ctor))();
      // The require hook registered by enableInstrumentations only covers CJS
      // consumers, and only for requires that happen after init(). Patch the
      // build in use directly so ESM apps and require-before-init both work.
      await patchActiveBuild(instrumentation, "openai", openaiPatchable);
      // Still returned for registration: the patched methods read the
      // instrumentation's tracer per call, so it has to be bound to our tracer
      // provider to emit anywhere.
      return instrumentation;
    },
  },
  {
    name: "anthropic",
    kind: "instrumentation",
    async load() {
      const mod = await optional("@arizeai/openinference-instrumentation-anthropic");
      const Ctor = mod?.AnthropicInstrumentation as (new () => ManuallyInstrumentable) | undefined;
      if (Ctor === undefined) return undefined;
      const instrumentation = new Ctor();
      // Same dual-build handling as the openai entry above.
      await patchActiveBuild(instrumentation, "@anthropic-ai/sdk", anthropicPatchable);
      return instrumentation;
    },
  },
  {
    name: "langchain",
    kind: "instrumentation",
    async load() {
      const mod = await optional("@arizeai/openinference-instrumentation-langchain");
      const Ctor = mod?.LangChainInstrumentation as
        | (new () => { manuallyInstrument(module: object): void })
        | undefined;
      if (Ctor === undefined) return undefined;

      // @langchain/core exposes its callback manager only as a subpath, and the
      // instrumentation's own module hook targets an internal file inside that
      // package that a normal import never routes through. The package therefore
      // documents manuallyInstrument() as the only way to patch it. Resolving the
      // subpath here rather than asking the caller for it keeps the entry lazy and
      // keeps the patch from being a no-op: a consumer who installs the
      // instrumentation but never calls manuallyInstrument gets nothing.
      //
      // This resolves the same copy the consumer's own chains use, so long as
      // there is one copy of @langchain/core on the resolution path, which is why
      // it is declared as an optional peer rather than imported blind.
      const callbacks = await optional("@langchain/core/callbacks/manager");
      if (callbacks?.CallbackManager === undefined) return undefined;

      const instrumentation = new Ctor();
      instrumentation.manuallyInstrument(callbacks);
      // Returned rather than treated as self-applying: the patched callback
      // manager reads the instrumentation's tracer on every call, so it still has
      // to be registered against our tracer provider to emit anywhere.
      return instrumentation;
    },
  },
  {
    name: "mcp",
    kind: "self-applying",
    async load(_tracerProvider?: TracerProvider, teardown?: Array<() => void>) {
      const mod = await optional("@modelcontextprotocol/sdk/client/index.js");
      const ClientClass = mod?.Client as McpClientLike | undefined;
      if (ClientClass === undefined) return undefined;
      const { instrumentMcpClient } = await import("./instrumentationMcp.js");
      // Both patches hand back an uninstall; shutdown() runs them so the
      // prototype is the SDK's own again and the next init() re-patches.
      // Patch first, push second: `teardown?.push(patch())` would skip the
      // patch itself whenever no collector is passed, optional chaining
      // short-circuits the arguments too.
      const uninstallEsm = instrumentMcpClient(ClientClass);
      teardown?.push(uninstallEsm);
      // The dynamic import above resolves the ESM build, but the MCP SDK
      // dual-builds: a CJS consumer's require() returns a DIFFERENT Client
      // class, whose tool calls would go unobserved while ready still
      // reports "mcp". Patch the cached CJS build too when the app has
      // required it. instrumentMcpClient is idempotent, so a package that
      // resolves both conditions to one build is patched once. Residual gap,
      // same as the providers': a CJS require that happens only after
      // init() is not in the cache yet and stays unpatched.
      const cjs = cachedCjsExports("@modelcontextprotocol/sdk", mcpClientPatchable) as
        | { Client: McpClientLike }
        | undefined;
      if (cjs !== undefined) {
        const uninstallCjs = instrumentMcpClient(cjs.Client);
        teardown?.push(uninstallCjs);
      }
      // The patch already ran; the truthy return only tells the caller the
      // package was present, there is nothing further to attach.
      return true;
    },
  },
];

/**
 * Enable every registry entry whose package is present. Processors go to
 * `sink`; instrumentations are registered against `tracerProvider`. Returns the
 * names enabled. Never throws: a broken optional integration must not break
 * init().
 */
export async function enableInstrumentations(
  sink: ProcessorSink,
  tracerProvider: TracerProvider,
  names?: string[],
  teardown?: Array<() => void>,
): Promise<string[]> {
  const wanted = names ? REGISTRY.filter((e) => names.includes(e.name)) : REGISTRY;
  const enabled: string[] = [];

  for (const entry of wanted) {
    try {
      const loaded = await entry.load(tracerProvider, teardown);
      if (loaded === undefined) continue;

      if (entry.kind === "processor") {
        if (entry.insert === "first") sink.addFirst(loaded as SpanProcessor);
        else sink.add(loaded as SpanProcessor);
      } else if (entry.kind === "instrumentation") {
        // The disable function is what makes a later init() work: the
        // OpenInference instrumentations guard against double patching, so
        // unless shutdown() disables this one, its patches stay bound to the
        // tracer it was enabled with and the next client records nothing
        // from the provider SDKs while `ready` still names them.
        const disable = registerInstrumentations({
          instrumentations: [loaded as Instrumentation],
          tracerProvider,
        });
        teardown?.push(disable);
      }
      // "self-applying" entries already took effect inside load(); there is
      // nothing further to attach.
      enabled.push(entry.name);
    } catch (error) {
      // Only reached when load() THREW, which means the package was reachable
      // but enabling it failed: a constructor rejecting its input, or a patch
      // onto a prototype that is no longer writable. The user installed this
      // optional peer deliberately and expects instrumentation, so a silent skip
      // would leave them with nothing and no explanation. An ABSENT package
      // returns undefined above and stays quiet, which is the distinction this
      // whole loud/quiet split exists to preserve.
      //
      // Still not fatal: warn, then carry on to the next entry so one broken
      // integration cannot block the others.
      warnBroken(entry.name, error);
    }
  }
  return enabled;
}
