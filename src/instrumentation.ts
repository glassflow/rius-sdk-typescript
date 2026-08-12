import type { TracerProvider } from "@opentelemetry/api";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

export type EntryKind = "instrumentation" | "processor";

export interface RegistryEntry {
  name: string;
  kind: EntryKind;
  /** Resolves undefined when the optional package is not installed. */
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
}

// esbuild rewrites a bare `import()` into `require()` in the CJS build, and
// @arizeai/openinference-vercel is ESM-only (type: module, no require
// condition), so a rewritten call throws ERR_PACKAGE_PATH_NOT_EXPORTED and the
// integration would silently vanish for every CommonJS consumer. Building the
// function at runtime keeps a real dynamic import in both output formats.
const dynamicImport = new Function("s", "return import(s)") as (
  s: string,
) => Promise<Record<string, unknown>>;

async function importModule(specifier: string): Promise<Record<string, unknown>> {
  try {
    return await dynamicImport(specifier);
  } catch (error) {
    // Sandboxed module runners (a vm context without an import callback) reject
    // dynamic import from a runtime-built function. Falling back keeps the
    // registry resolvable there, so an absent package is still reported as
    // absent rather than as broken. Shipped CJS consumers use the path above.
    if ((error as { code?: string }).code !== "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING") throw error;
    try {
      return (await import(specifier)) as Record<string, unknown>;
    } catch (fallbackError) {
      // Such loaders report an unresolvable specifier as a codeless Error, so a
      // resolution failure is normalised to the code the caller checks. Only
      // resolution failures: any other error still surfaces as "installed but
      // broken", which must stay loud.
      const message = (fallbackError as Error).message ?? "";
      if (
        (fallbackError as { code?: string }).code === undefined &&
        /cannot find (module|package)|could not resolve|failed to load url|is it installed|does the file exist/i.test(
          message,
        )
      ) {
        (fallbackError as { code?: string }).code = "ERR_MODULE_NOT_FOUND";
      }
      throw fallbackError;
    }
  }
}

async function optional(specifier: string): Promise<Record<string, unknown> | undefined> {
  try {
    return await importModule(specifier);
  } catch (error) {
    const code = (error as { code?: string }).code;
    // Not installed is the normal optional-peer case and stays quiet. Anything
    // else means the package IS present but failed to load, which must be loud:
    // a silent skip here looks identical to "user did not install it".
    if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") {
      console.warn(
        `[rius] integration "${specifier}" is installed but failed to load: ${(error as Error).message}`,
      );
    }
    return undefined;
  }
}

/**
 * Bundled integrations. Packages are imported lazily so none is a hard
 * dependency; install them as optional peers and init() enables what it finds.
 *
 * Two kinds on purpose: OpenInference ships the Vercel AI SDK support as a
 * SPAN PROCESSOR, which must reach the provider through the processor sink,
 * while OpenAI support is a conventional instrumentation.
 */
export const REGISTRY: RegistryEntry[] = [
  {
    name: "vercel-ai",
    kind: "processor",
    async load() {
      const mod = await optional("@arizeai/openinference-vercel");
      const Ctor = (mod?.OpenInferenceBatchSpanProcessor ??
        mod?.OpenInferenceSimpleSpanProcessor) as (new () => unknown) | undefined;
      return Ctor ? new Ctor() : undefined;
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
        sink.add(loaded as SpanProcessor);
      } else {
        const core = await optional("@opentelemetry/instrumentation");
        const register = core?.registerInstrumentations as
          | ((cfg: { instrumentations: unknown[]; tracerProvider: TracerProvider }) => void)
          | undefined;
        if (register === undefined) continue;
        register({ instrumentations: [loaded], tracerProvider });
      }
      enabled.push(entry.name);
    } catch {
      // a failing integration is skipped, never fatal
    }
  }
  return enabled;
}
