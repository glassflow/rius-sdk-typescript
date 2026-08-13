import { createRequire } from "node:module";
import { join, sep } from "node:path";
import type { TracerProvider } from "@opentelemetry/api";
import { type Instrumentation, registerInstrumentations } from "@opentelemetry/instrumentation";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { McpClientLike } from "./instrumentationMcp.js";

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
   */
  load(): Promise<unknown | undefined>;
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
 * sees the CJS one, so a pure-ESM app would silently get no spans. Their
 * `patch()` is also guarded by a module-global flag
 * (github.com/Arize-ai/openinference/issues/3557), so only ONE build can be
 * patched per process and the choice matters:
 *
 * - CJS build already in `require.cache` → the app requires it, patch that
 *   copy. This also covers a require that happened BEFORE init(), which the
 *   require hook alone never repairs.
 * - Otherwise → import the ESM build and patch it. In an ESM app every static
 *   import already ran before init(), so this is the copy in use. The one
 *   pattern this trades away is a CJS app whose only require of the provider
 *   comes after init(): it gets the ESM build patched instead (documented).
 *
 * The patchable is a plain-object wrapper, never the ESM namespace itself:
 * `patch()` writes an `openInferencePatched` marker onto what it receives, and
 * a frozen ESM namespace would throw on that write.
 *
 * Prototype patching needs no import-order cooperation from the app — clients
 * constructed before init() share the same prototype and are covered too.
 */
async function patchActiveBuild(
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
  if (patchable !== undefined) instrumentation.manuallyInstrument(patchable);
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
 * Bundled integrations. Packages are imported lazily so none is a hard
 * dependency; install them as optional peers and init() enables what it finds.
 *
 * Two kinds on purpose: the Vercel AI SDK support is contributed as a SPAN
 * PROCESSOR, while the OpenAI, Anthropic and LangChain support are conventional
 * instrumentations.
 */
export const REGISTRY: RegistryEntry[] = [
  {
    name: "vercel-ai",
    kind: "processor",
    // The transform can ADD content attributes such as input.value. Masking
    // runs in the exporter chain, which executes after a span is queued, so the
    // transform has to run before the exporting processor sees the span or the
    // attributes it added would never be sanitised.
    insert: "first",
    async load() {
      // Deliberately NOT the package's own OpenInferenceBatchSpanProcessor /
      // OpenInferenceSimpleSpanProcessor: both require an exporter and export
      // through it, so adding one alongside our exporting processor would send
      // every span twice, once raw and once transformed. Only the attribute
      // transform is wanted, wrapped in a processor of ours that never exports.
      const utils = await optional("@arizeai/openinference-vercel/utils");
      const add = utils?.addOpenInferenceAttributesToSpan as
        | ((span: ReadableSpan) => void)
        | undefined;
      if (add === undefined) return undefined;
      return {
        onStart() {},
        onEnd(span: ReadableSpan) {
          add(span);
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
      const Ctor = mod?.OpenAIInstrumentation as (new () => ManuallyInstrumentable) | undefined;
      if (Ctor === undefined) return undefined;
      const instrumentation = new Ctor();
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
    async load() {
      const mod = await optional("@modelcontextprotocol/sdk/client/index.js");
      const ClientClass = mod?.Client as McpClientLike | undefined;
      if (ClientClass === undefined) return undefined;
      const { instrumentMcpClient } = await import("./instrumentationMcp.js");
      instrumentMcpClient(ClientClass);
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
): Promise<string[]> {
  const wanted = names ? REGISTRY.filter((e) => names.includes(e.name)) : REGISTRY;
  const enabled: string[] = [];

  for (const entry of wanted) {
    try {
      const loaded = await entry.load();
      if (loaded === undefined) continue;

      if (entry.kind === "processor") {
        if (entry.insert === "first") sink.addFirst(loaded as SpanProcessor);
        else sink.add(loaded as SpanProcessor);
      } else if (entry.kind === "instrumentation") {
        registerInstrumentations({
          instrumentations: [loaded as Instrumentation],
          tracerProvider,
        });
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
