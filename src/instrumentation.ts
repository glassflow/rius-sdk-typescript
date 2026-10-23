import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import type { TracerProvider } from "@opentelemetry/api";
import { type Instrumentation, registerInstrumentations } from "@opentelemetry/instrumentation";
import { aggregatingTracer } from "./aggregatedUsage.js";
import { installEmbeddingsUsage } from "./embeddingsUsage.js";
import type { McpClientLike } from "./instrumentationMcp.js";
import { TRACER_NAME } from "./semconv.js";
import { SDK_VERSION } from "./version.js";

/**
 * `"self-applying"` is for an entry whose `load()` has already taken full
 * effect by the time it resolves (e.g. by monkey-patching a prototype)
 * rather than returning something for `enableInstrumentations` to attach.
 * There is nothing to hand to `registerInstrumentations`, so it is a
 * distinct kind rather than a marker on the loaded value:
 * dispatch stays a single switch on `kind`, and the loaded value's shape
 * does not have to double as a signal.
 */
export type EntryKind = "instrumentation" | "self-applying";

export interface RegistryEntry {
  name: string;
  kind: EntryKind;
  /**
   * The package whose listing in the app's `package.json` means the user wants
   * this integration. When `load()` resolves undefined and this package is
   * listed, the SDK warns instead of staying quiet, since "listed but not
   * loadable" is a different situation from "never installed".
   */
  optInPackage?: string;
  /**
   * What to install for this integration, said to a user who names it in
   * `init({ instruments })` when it could not be enabled. The fix differs by
   * entry: most need an OpenInference package beside the library, while the
   * built-in ones enable themselves once the library is there.
   */
  install?: string;
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
   *
   * `modules` carries the modules the app passed to `init()` itself; an entry
   * that has one uses it instead of resolving its packages.
   */
  load(
    tracerProvider?: TracerProvider,
    teardown?: Array<() => void>,
    modules?: InstrumentModules,
  ): Promise<unknown | undefined>;
}

/**
 * One provider integration, handed over by the app rather than resolved by the
 * SDK. Both fields are module namespaces, as produced by `import * as`.
 */
export interface InjectedIntegration {
  /**
   * The module namespace of the OpenInference instrumentation package for this
   * provider (`import * as instrumentation from
   * "@arizeai/openinference-instrumentation-anthropic"`).
   */
  instrumentation: object;
  /**
   * The module namespace of the provider SDK (`import * as sdk from
   * "@anthropic-ai/sdk"`). It must be the copy the app's own client calls go
   * through, since that is the one that gets patched.
   */
  sdk: object;
}

/**
 * The integrations an app can hand to `init()` directly. Only the provider SDK
 * integrations take part; the others are always resolved by the SDK.
 */
export interface InstrumentModules {
  anthropic?: InjectedIntegration;
  openai?: InjectedIntegration;
}

/** Inputs to {@link enableInstrumentations} beyond the entries themselves. */
export interface EnableOptions {
  /** Modules the app imported itself; see {@link InstrumentModules}. */
  instrumentModules?: InstrumentModules;
  /**
   * The package names the app's `package.json` lists. Defaults to reading the
   * `package.json` in `process.cwd()`; a test passes its own.
   */
  declaredDependencies?: () => ReadonlySet<string>;
  /**
   * Called with each integration's name as soon as it is enabled, before the
   * next one loads. A throw is caught and the integration stays enabled.
   * Whatever the callback pushes onto `teardown` runs when this client lets
   * go of the integration: at its shutdown, or when another client takes it.
   */
  onEnabled?: (name: string, teardown: Array<() => void>) => void;
  /**
   * False for a client that does not own the OpenTelemetry globals (a scoped
   * client). Such a client leaves an integration that a live global client
   * holds where it is. Defaults to true.
   */
  forGlobal?: boolean;
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

/**
 * The package names listed in the `package.json` of `dir`, across dependencies,
 * devDependencies and optionalDependencies. Best effort: a missing, unreadable
 * or malformed file gives an empty set, never an error.
 *
 * @internal Exported for tests. Not re-exported from the package entry point.
 */
export function readDeclaredDependencies(dir: string): ReadonlySet<string> {
  const names = new Set<string>();
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (typeof manifest !== "object" || manifest === null) return names;
    for (const field of DEPENDENCY_FIELDS) {
      if (!Object.hasOwn(manifest, field)) continue;
      const listed = (manifest as Record<string, unknown>)[field];
      if (typeof listed !== "object" || listed === null || Array.isArray(listed)) continue;
      for (const name of Object.keys(listed)) names.add(name);
    }
  } catch {
    return new Set();
  }
  return names;
}

// esbuild rewrites a bare `import()` into `require()` in the CJS build, and
// `ai` v7 and @ai-sdk/otel are ESM-only (type: module, no require condition),
// so a rewritten call throws ERR_PACKAGE_PATH_NOT_EXPORTED and the integration
// would silently vanish for every CommonJS consumer. Building the
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

/**
 * @internal Exported for tests. Not re-exported from the package entry point.
 */
export async function optional(specifier: string): Promise<Record<string, unknown> | undefined> {
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
 * How many "present but broken" warnings have been logged. A load() that
 * resolves undefined after this moved was not absent: the import already
 * reported why, so the listed-but-unreachable warning must not repeat it.
 */
let brokenReports = 0;

/**
 * The single warn path for "present but broken". `subject` is a module specifier
 * when an import failed and an entry name when enabling one failed. Accepts an
 * unknown throwable and never throws itself, so it is safe on any error path.
 */
function warnBroken(subject: string, error: unknown): void {
  brokenReports++;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[rius] integration "${subject}" is installed but failed to load: ${message}`);
}

/**
 * The warn path for "the app lists this package but the SDK could not load it".
 * Never throws.
 */
function warnDeclaredUnloaded(entryName: string, pkg: string): void {
  const what = `integration "${entryName}" is not instrumented: ${pkg} is listed in package.json`;
  console.warn(
    `[rius] ${what} but the SDK could not load it. Pass the modules your app imports to init({ instrumentModules }) to enable it.`,
  );
}

/**
 * The packages the app lists, or none when they cannot be read. The warning
 * this feeds is best effort, so a failing reader (a working directory that no
 * longer exists, say) must stay quiet rather than be reported as a broken
 * integration.
 */
function declaredDependenciesOf(read?: () => ReadonlySet<string>): ReadonlySet<string> {
  try {
    return (read ?? (() => readDeclaredDependencies(process.cwd())))();
  } catch {
    return new Set();
  }
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
 * -openai >= 4.2.1, both below the floors package.json pins), so the require hook can
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
  prepare?: (patchable: object) => void,
): Promise<void> {
  const cached = cachedCjsExports(pkg, toPatchable);
  if (cached !== undefined) {
    prepare?.(cached);
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
  prepare?.(patchable);
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

interface PatchingInstrumentation extends ManuallyInstrumentable {
  patch(moduleExports: unknown, moduleVersion?: string): unknown;
  unpatch(moduleExports: unknown, moduleVersion?: string): void;
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
 * Enables a provider integration from modules the app injected, resolving
 * nothing: the app's own static imports are what a file tracer deploys, so this
 * path does not depend on the installed `node_modules` layout the way the
 * SDK's runtime-built imports do.
 *
 * Throws on a wrongly shaped module so `enableInstrumentations` logs its one
 * warning for the entry. The app passed the module on purpose, so a silent skip
 * would hide a mistake it can fix.
 */
function loadInjected(
  option: string,
  injected: InjectedIntegration,
  exportName: string,
  toPatchable: (exports: Record<string, unknown>) => object | undefined,
  construct: (Ctor: new () => PatchingInstrumentation) => ManuallyInstrumentable,
  prepare?: (patchable: object) => void,
): ManuallyInstrumentable {
  const Ctor = (injected.instrumentation as Record<string, unknown>)[exportName];
  if (typeof Ctor !== "function") {
    throw new Error(`instrumentModules.${option}.instrumentation does not export ${exportName}`);
  }
  const instrumentation = construct(Ctor as new () => PatchingInstrumentation);
  const patchable = toPatchable(injected.sdk as Record<string, unknown>);
  if (patchable === undefined) {
    throw new Error(
      `instrumentModules.${option}.sdk is not the ${option === "openai" ? "openai" : "@anthropic-ai/sdk"} module namespace`,
    );
  }
  prepare?.(patchable);
  instrumentation.manuallyInstrument(patchable);
  return instrumentation;
}

/** The injected integration for `name`, only when the app set it as its own property. */
function injectedFor(
  modules: InstrumentModules | undefined,
  name: keyof InstrumentModules,
): InjectedIntegration | undefined {
  if (modules === undefined || !Object.hasOwn(modules, name)) return undefined;
  return modules[name];
}

/**
 * Bundled integrations. Packages are imported lazily so none is a hard
 * dependency; install them as optional peers and init() enables what it finds.
 *
 * The OpenAI, Anthropic and LangChain support are conventional
 * instrumentations; the Vercel AI SDK and MCP support apply themselves (a
 * telemetry registration, a prototype patch).
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
    | (new (options: {
        tracer: unknown;
        usage: boolean;
      }) => unknown)
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
  // Wrapped because @ai-sdk/otel reports a run's total usage on its
  // invoke_agent span as well as each call's on its chat span; the wrapper
  // lets the normalizer move that total out of gen_ai.usage.*. `usage`
  // because the integration writes the reasoning split only with it, and only
  // under ai.usage.*, which the normalizer maps.
  const integration = new OpenTelemetryIntegration({
    tracer: aggregatingTracer(tracerProvider.getTracer(TRACER_NAME, SDK_VERSION)),
    usage: true,
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

export const REGISTRY: RegistryEntry[] = [
  {
    name: "vercel-ai",
    // Self-applying: on ai v7 the registration IS the integration (see
    // registerVercelTelemetry above). v5/v6 apps need nothing here: their
    // spans come from per-call `experimental_telemetry`, and the normalizer
    // maps their ai.* dialect itself, the way the sink does, so this entry
    // reports them as nothing to enable.
    kind: "self-applying",
    install:
      "it registers on the Vercel AI SDK v7 or newer: install `ai` and `@ai-sdk/otel` (AI SDK v5 and v6 need no integration; pass `experimental_telemetry` per call)",
    async load(tracerProvider?: TracerProvider, teardown?: Array<() => void>) {
      if (tracerProvider === undefined) return undefined;
      return (await registerVercelTelemetry(tracerProvider, teardown)) ? true : undefined;
    },
  },
  {
    name: "openai",
    kind: "instrumentation",
    optInPackage: "@arizeai/openinference-instrumentation-openai",
    install: "install `@arizeai/openinference-instrumentation-openai` beside `openai`",
    async load(
      _tracerProvider?: TracerProvider,
      teardown?: Array<() => void>,
      modules?: InstrumentModules,
    ) {
      // Embeddings token counts, which the instrumentation does not record
      // (see embeddingsUsage.ts). Installed on the very build the
      // instrumentation is about to patch, right before it patches, so it ends
      // up underneath the instrumentation's wrapper. A CJS build first
      // required after init() is patched by the instrumentation's require hook
      // alone and gets no counts, the same residual gap as the providers'.
      const prepare = (patchable: object): void => {
        const uninstall = installEmbeddingsUsage(patchable);
        teardown?.push(uninstall);
      };
      const injected = injectedFor(modules, "openai");
      if (injected !== undefined) {
        return loadInjected(
          "openai",
          injected,
          "OpenAIInstrumentation",
          openaiPatchable,
          (Ctor) => new Ctor(),
          prepare,
        );
      }
      const mod = await optional("@arizeai/openinference-instrumentation-openai");
      const Ctor = mod?.OpenAIInstrumentation as (new () => PatchingInstrumentation) | undefined;
      if (Ctor === undefined) return undefined;
      const instrumentation = new Ctor();
      // The require hook registered by enableInstrumentations only covers CJS
      // consumers, and only for requires that happen after init(). Patch the
      // build in use directly so ESM apps and require-before-init both work.
      await patchActiveBuild(instrumentation, "openai", openaiPatchable, prepare);
      // Still returned for registration: the patched methods read the
      // instrumentation's tracer per call, so it has to be bound to our tracer
      // provider to emit anywhere.
      return instrumentation;
    },
  },
  {
    name: "anthropic",
    kind: "instrumentation",
    optInPackage: "@arizeai/openinference-instrumentation-anthropic",
    install:
      "install `@arizeai/openinference-instrumentation-anthropic` beside `@anthropic-ai/sdk`",
    async load(
      _tracerProvider?: TracerProvider,
      _teardown?: Array<() => void>,
      modules?: InstrumentModules,
    ) {
      const injected = injectedFor(modules, "anthropic");
      if (injected !== undefined) {
        return loadInjected(
          "anthropic",
          injected,
          "AnthropicInstrumentation",
          anthropicPatchable,
          (Ctor) => new Ctor(),
        );
      }
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
    install: "install `@arizeai/openinference-instrumentation-langchain` beside `@langchain/core`",
    async load(_tracerProvider?: TracerProvider, teardown?: Array<() => void>) {
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
      // The instrumentation never makes its spans current, so the provider
      // call a chat model makes would land in a trace of its own; see
      // langchainSpanContext. Install first, push second, as for mcp below.
      const { installLangchainSpanContext } = await import("./langchainSpanContext.js");
      const uninstallSpanContext = installLangchainSpanContext(
        await optional("@langchain/core/language_models/chat_models"),
        await optional("@langchain/core/callbacks/promises"),
      );
      teardown?.push(uninstallSpanContext);
      // Returned rather than treated as self-applying: the patched callback
      // manager reads the instrumentation's tracer on every call, so it still has
      // to be registered against our tracer provider to emit anywhere.
      return instrumentation;
    },
  },
  {
    name: "mcp",
    kind: "self-applying",
    install: "it is built in and enables itself once `@modelcontextprotocol/sdk` is installed",
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

/** A client's hold on one integration. */
interface Holder {
  provider: TracerProvider;
  /** Whether the client owns the OpenTelemetry globals. */
  global: boolean;
  /** Undoes the integration for this client. Runs once, however often it is called. */
  release: () => void;
}

/**
 * Which client each integration is bound to. An integration patches a library
 * for the whole process, so only one client can have it: enabling it for a
 * second client first undoes it for the first, except that a scoped client
 * never takes one from a live global client, which would move every span of
 * that library off the global client. An entry leaves the map when its holder
 * lets go of it.
 */
const holders = new Map<string, Holder>();

/**
 * The integration names the caller asked for, or undefined for the default
 * set. Never throws: a name that is not a string, or names that are not a
 * list, warn and are skipped.
 */
function requestedNames(names: unknown): ReadonlySet<string> | undefined {
  if (names === undefined) return undefined;
  if (!Array.isArray(names)) {
    console.warn(
      `[rius] instruments must be a list of integration names, got ${typeof names}; enabling every integration found.`,
    );
    return undefined;
  }
  const known = REGISTRY.map((entry) => entry.name);
  const requested = new Set<string>();
  for (const name of names as unknown[]) {
    if (typeof name === "string" && known.includes(name)) {
      requested.add(name);
      continue;
    }
    console.warn(
      `[rius] unknown instrument ${typeof name === "string" ? `"${name}"` : String(name)}; known instruments: ${[...known].sort().join(", ")}`,
    );
  }
  return requested;
}

/**
 * Enable the registry entries whose packages are present: every one when
 * `names` is undefined, else only the named ones, warning about a name that is
 * unknown or whose packages are missing. Instrumentations are registered
 * against `tracerProvider`; self-applying entries take effect in their own
 * `load()`. Returns the names enabled. Never throws: a broken optional
 * integration must not break init().
 */
export async function enableInstrumentations(
  tracerProvider: TracerProvider,
  names?: readonly string[],
  teardown?: Array<() => void>,
  options?: EnableOptions,
): Promise<string[]> {
  const requested = requestedNames(names);
  const forGlobal = options?.forGlobal ?? true;
  const wanted = requested ? REGISTRY.filter((e) => requested.has(e.name)) : [...REGISTRY];
  const enabled: string[] = [];
  // Read lazily and at most once: most runs never have an unloaded entry that
  // carries an opt-in package, and the read touches the filesystem.
  let declared: ReadonlySet<string> | undefined;

  for (const entry of wanted) {
    const holder = holders.get(entry.name);
    if (holder !== undefined) {
      if (!forGlobal && holder.global) {
        console.warn(
          `[rius] instrument "${entry.name}" stays with the global Rius client: an integration patches its library for the whole process, and moving it to a scoped client would take every ${entry.name} span away from the global one.`,
        );
        continue;
      }
      // Enabled for another client (or before a re-init): undo it there, so
      // the patch is applied afresh for this one.
      holder.release();
    }
    // Everything that undoes this entry for this client, run together when
    // the client lets go of it.
    const undo: Array<() => void> = [];
    try {
      const reportedBefore = brokenReports;
      const loaded = await entry.load(tracerProvider, undo, options?.instrumentModules);
      if (loaded === undefined) {
        runAll(undo);
        if (brokenReports !== reportedBefore) continue;
        if (requested !== undefined) {
          // Named on purpose, so say what is missing rather than staying quiet.
          console.warn(
            `[rius] instrument "${entry.name}" was requested but could not be enabled; ${entry.install ?? "its packages are not installed"}.`,
          );
        } else if (entry.optInPackage !== undefined) {
          declared ??= declaredDependenciesOf(options?.declaredDependencies);
          if (declared.has(entry.optInPackage))
            warnDeclaredUnloaded(entry.name, entry.optInPackage);
        }
        continue;
      }

      if (entry.kind === "instrumentation") {
        // The disable function is what makes a later init() work: the
        // OpenInference instrumentations guard against double patching, so
        // unless shutdown() disables this one, its patches stay bound to the
        // tracer it was enabled with and the next client records nothing
        // from the provider SDKs while `ready` still names them.
        const disable = registerInstrumentations({
          instrumentations: [loaded as Instrumentation],
          tracerProvider,
        });
        undo.push(disable);
      }
      // "self-applying" entries already took effect inside load(); there is
      // nothing further to attach.
      enabled.push(entry.name);
      try {
        options?.onEnabled?.(entry.name, undo);
      } catch {
        // The integration is attached either way; the callback is the caller's.
      }
    } catch (error) {
      runAll(undo);
      // Only reached when load() THREW, which means the package was reachable
      // but enabling it failed: a constructor rejecting its input, or a patch
      // onto a prototype that is no longer writable. The user installed this
      // optional peer deliberately and expects instrumentation, so a silent skip
      // would leave them with nothing and no explanation. An ABSENT package
      // returns undefined above. That stays quiet too, unless the app named
      // the integration or its package.json lists the entry's package: then
      // the user wanted it and the SDK just could not reach it, which gets its
      // own warning there. Only a package that is neither installed nor asked
      // for is skipped without a word, which is the distinction this whole
      // loud/quiet split exists to preserve.
      //
      // Still not fatal: warn, then carry on to the next entry so one broken
      // integration cannot block the others.
      warnBroken(entry.name, error);
      continue;
    }
    let released = false;
    const held: Holder = {
      provider: tracerProvider,
      global: forGlobal,
      release: () => {
        if (released) return;
        released = true;
        if (holders.get(entry.name) === held) holders.delete(entry.name);
        runAll(undo);
      },
    };
    holders.set(entry.name, held);
    teardown?.push(held.release);
  }
  return enabled;
}

/** Runs every function in `undo`, in order; one that throws does not stop the rest. */
function runAll(undo: Array<() => void>): void {
  for (const fn of undo.splice(0)) {
    try {
      fn();
    } catch {
      // A patch that cannot be undone must not block the others.
    }
  }
}
