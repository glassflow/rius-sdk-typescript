import { createRequire } from "node:module";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { errorType, exceptionForRecording, qualifyRecordedExceptions } from "../src/errorType.js";
import { NormalizingSpanProcessor } from "../src/normalize.js";
import { EXCEPTION_EVENT, EXCEPTION_TYPE } from "../src/semconv.js";
import { startAsCurrentSpan } from "../src/spans.js";
import fixture from "./fixtures/provider_error_types.json" with { type: "json" };

// Real error objects from the installed provider SDKs, built the way each
// SDK's client builds them from a response (`APIError.generate`) or from a
// failed fetch (`APIConnectionError`). No network.

const require = createRequire(import.meta.url);

interface ProviderErrors {
  APIError: {
    generate(status: number, body: unknown, message: string | undefined, headers: Headers): Error;
  };
  APIConnectionError: new (options: { message?: string; cause?: Error }) => Error;
}

const SDKS: Record<string, { module: ProviderErrors; body: unknown }> = {
  // The error bodies each API returns; `generate` reads them differently.
  anthropic: {
    module: require("@anthropic-ai/sdk") as ProviderErrors,
    body: { type: "error", error: { type: "not_found_error", message: "model: claude-nope-1" } },
  },
  openai: {
    module: require("openai") as ProviderErrors,
    body: { error: { message: "no such model", type: "invalid_request_error", code: "model_x" } },
  },
};

function providerError(pkg: string, status: number | null): Error {
  const sdk = SDKS[pkg];
  if (sdk === undefined) throw new Error(`test setup: no SDK ${pkg}`);
  if (status === null) return new sdk.module.APIConnectionError({ message: "fetch failed" });
  return sdk.module.APIError.generate(status, sdk.body, undefined, new Headers());
}

describe("the provider SDK errors this relies on", () => {
  it("inherit the generic name, so err.name alone says nothing", () => {
    // If a provider starts setting its own name, the constructor fallback is
    // no longer what names it; this pins the premise.
    for (const pkg of Object.keys(SDKS)) {
      const error = providerError(pkg, 404);
      expect(error.name).toBe("Error");
      expect(error.constructor.name).toBe("NotFoundError");
    }
  });
});

describe("errorType for provider SDK errors (shared fixture)", () => {
  for (const c of fixture.cases) {
    it(`${c.package} ${c.status ?? "no response"} -> ${c.typescript}`, () => {
      expect(errorType(providerError(c.package, c.status))).toBe(c.typescript);
    });
  }

  it("matches Python wherever the provider SDKs agree on the class", () => {
    for (const c of fixture.cases) {
      if (!("divergence" in c)) expect(c.typescript).toBe(c.python);
    }
  });
});

describe("errorType for everything else", () => {
  it("is still Error for a plain Error", () => {
    expect(errorType(new Error("x"))).toBe("Error");
  });

  it("keeps a built-in subclass's own name", () => {
    expect(errorType(new TypeError("x"))).toBe("TypeError");
  });

  it("uses the class name when a subclass inherits the generic name", () => {
    class QuotaExceeded extends Error {}
    expect(errorType(new QuotaExceeded("x"))).toBe("QuotaExceeded");
  });

  it("never qualifies a class that is not a provider's", () => {
    class Unrelated extends Error {}
    class Child extends Unrelated {}
    expect(errorType(new Child("x"))).toBe("Child");
  });

  it("keeps a name the error set itself over its class name", () => {
    class GatewayFailure extends Error {
      constructor(message: string) {
        super(message);
        this.name = "GatewayInternalServerError";
      }
    }
    expect(errorType(new GatewayFailure("x"))).toBe("GatewayInternalServerError");
  });

  it("does not follow an own `constructor` property", () => {
    // Only the prototype's constructor is the class; an own property is data.
    const error = Object.assign(new Error("x"), { constructor: class Spoofed {} });
    expect(errorType(error)).toBe("Error");
  });

  it("falls back to the runtime type for a non-Error throwable", () => {
    expect(errorType("just a string")).toBe("string");
    expect(errorType(42)).toBe("number");
  });
});

describe("exceptionForRecording", () => {
  it("hands OTel the qualified name, the message and the stack", () => {
    const error = providerError("anthropic", 404);
    expect(exceptionForRecording(error)).toEqual({
      name: "anthropic.NotFoundError",
      message: error.message,
      stack: error.stack,
    });
  });

  it("drops a provider's API error code, which OTel would prefer over the name", () => {
    // OTel's recordException writes `code` into exception.type when present,
    // so an OpenAI body code would otherwise win over the class.
    const error = providerError("openai", 404) as Error & { code?: string };
    expect(error.code).toBe("model_x");
    expect(exceptionForRecording(error)).not.toHaveProperty("code");
  });

  it("returns an error it cannot name better untouched, code included", () => {
    // A Node system error: name "Error", class Error, code ECONNREFUSED.
    const error = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(exceptionForRecording(error)).toBe(error);
    expect(exceptionForRecording("a string")).toBe("a string");
  });
});

function recordOn(error: unknown, processor = new NormalizingSpanProcessor()) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [processor, new SimpleSpanProcessor(exporter)],
  });
  const span = provider.getTracer("third-party").startSpan("call");
  // As an instrumentor does it: straight onto the SDK span.
  span.recordException(error as Error);
  span.setStatus({ code: 2 });
  span.end();
  const [finished] = exporter.getFinishedSpans();
  if (finished === undefined) throw new Error("test setup: no span");
  return finished;
}

describe("exceptions recorded by third-party instrumentors", () => {
  it("carry the qualified class in exception.type and error.type", () => {
    const span = recordOn(providerError("anthropic", 404));
    const event = span.events.find((e) => e.name === EXCEPTION_EVENT);
    expect(event?.attributes?.[EXCEPTION_TYPE]).toBe("anthropic.NotFoundError");
    expect(span.attributes["error.type"]).toBe("anthropic.NotFoundError");
  });

  it("keep OTel's own spelling for an error with nothing better to say", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const span = recordOn(error);
    const event = span.events.find((e) => e.name === EXCEPTION_EVENT);
    expect(event?.attributes?.[EXCEPTION_TYPE]).toBe("ECONNREFUSED");
  });

  it("wrap each span once, however many times it is offered", () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const span = provider.getTracer("t").startSpan("s");
    qualifyRecordedExceptions(span as never);
    const once = span.recordException;
    qualifyRecordedExceptions(span as never);
    expect(span.recordException).toBe(once);
    span.end();
  });
});

describe("the span helpers' own recordException", () => {
  it("types by class even under a provider Rius did not build", async () => {
    // No NormalizingSpanProcessor here, as when an application registers its
    // own provider: the helper's path must not depend on the processor's seam.
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
    try {
      await expect(
        startAsCurrentSpan("agent", async () => {
          throw providerError("anthropic", 404);
        }),
      ).rejects.toThrow();
      const [span] = exporter.getFinishedSpans();
      const event = span?.events.find((e) => e.name === EXCEPTION_EVENT);
      expect(event?.attributes?.[EXCEPTION_TYPE]).toBe("anthropic.NotFoundError");
      expect(span?.attributes["error.type"]).toBe("anthropic.NotFoundError");
    } finally {
      trace.disable();
    }
  });
});
