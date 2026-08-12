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

/**
 * Bundled integrations. Packages are imported lazily so none is a hard
 * dependency; install them as optional peers and init() enables what it finds.
 *
 * Two kinds on purpose: the Vercel AI SDK support is contributed as a SPAN
 * PROCESSOR, while OpenAI support is a conventional instrumentation.
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
      const Ctor = mod?.OpenAIInstrumentation as (new () => unknown) | undefined;
      return Ctor ? new Ctor() : undefined;
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
