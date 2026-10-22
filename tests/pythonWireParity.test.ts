// Wire behaviour the Python SDK, the reference, already has: each case here
// was a place the two SDKs exported different spans for the same call.
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type InitOptions, init, type RiusClient } from "../src/client.js";
import { otelResourceAttributes, resolveConfig } from "../src/config.js";
import { contextSizes } from "../src/contextSizes.js";
import { MaskingSpanExporter } from "../src/masking.js";
import { normalizeMessages, serializeMessages } from "../src/messages.js";
import { toInt } from "../src/normalize.js";
import { observe } from "../src/observe.js";
import { startAsCurrentSpan, startSpan } from "../src/spans.js";

let client: RiusClient | undefined;

afterEach(async () => {
  await client?.shutdown();
  client = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function start(options: InitOptions = {}): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter();
  client = init({ spanExporter: exporter, heartbeatTransport: async () => {}, ...options });
  return exporter;
}

async function finished(exporter: InMemorySpanExporter): Promise<ReadableSpan[]> {
  await client?.flush();
  return exporter.getFinishedSpans();
}

describe("input.value / output.value encoding", () => {
  it("writes numbers and booleans as their JSON text, as OpenInference defines them", async () => {
    const exporter = start();
    startSpan("s").setInput(1.5).setOutput(true).end();
    const [span] = await finished(exporter);
    expect(span.attributes["input.value"]).toBe("1.5");
    expect(span.attributes["output.value"]).toBe("true");
  });

  it("writes a non-finite number as Python's JSON encoder does", async () => {
    const exporter = start();
    startSpan("s").setInput(Number.NaN).setOutput(Number.POSITIVE_INFINITY).end();
    const [span] = await finished(exporter);
    expect(span.attributes["input.value"]).toBe("NaN");
    expect(span.attributes["output.value"]).toBe("Infinity");
  });

  it("writes null and undefined as null", async () => {
    const exporter = start();
    startSpan("s").setInput(undefined).setOutput(null).end();
    const [span] = await finished(exporter);
    expect(span.attributes["input.value"]).toBe("null");
    expect(span.attributes["output.value"]).toBe("null");
  });

  it("records an observed function's undefined result as null", async () => {
    const exporter = start();
    await observe(function noResult(): void {})();
    const [span] = await finished(exporter);
    expect(span.attributes["output.value"]).toBe("null");
  });

  it("still records no output when output capture is off", async () => {
    const exporter = start();
    await observe(function noResult(): void {}, { captureOutput: false })();
    const [span] = await finished(exporter);
    expect("output.value" in span.attributes).toBe(false);
  });

  it("writes a null inside a content list as a null text part", () => {
    expect(serializeMessages([{ role: "user", content: [null] }], "user")).toBe(
      '[{"role":"user","parts":[{"type":"text","content":"null"}]}]',
    );
  });
});

describe("message roles", () => {
  it("keeps an explicit null role rather than defaulting it", () => {
    const [plain] = normalizeMessages([{ role: null, content: "hi" }], "user");
    expect(plain.role).toBeNull();
    const [spec] = normalizeMessages([{ role: null, parts: [] }], "user");
    expect(spec.role).toBeNull();
  });

  it("still defaults a missing role", () => {
    const [plain] = normalizeMessages([{ content: "hi" }], "user");
    expect(plain.role).toBe("user");
    const [spec] = normalizeMessages([{ parts: [] }], "assistant");
    expect(spec.role).toBe("assistant");
  });
});

class Capture implements SpanExporter {
  seen: ReadableSpan[] = [];
  export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
    this.seen = spans;
    cb({ code: ExportResultCode.SUCCESS });
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

function errorSpan(attributes: Record<string, unknown>, message: string): ReadableSpan {
  return { attributes, status: { code: 2, message } } as unknown as ReadableSpan;
}

describe("a mask that returns nothing or throws", () => {
  for (const [label, result] of [
    ["null", null],
    ["undefined", undefined],
  ] as const) {
    it(`drops the attribute and the status description when it returns ${label}`, () => {
      const inner = new Capture();
      new MaskingSpanExporter(inner, { captureContent: true, mask: () => result }).export(
        [errorSpan({ "input.value": "secret", "gen_ai.request.model": "m" }, "secret")],
        () => {},
      );
      const [span] = inner.seen;
      expect("input.value" in span.attributes).toBe(false);
      expect(span.attributes["gen_ai.request.model"]).toBe("m");
      expect(span.status.message).toBeUndefined();
      expect(span.status.code).toBe(2);
    });
  }

  it("drops the attribute and the status description, and warns, when it throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const inner = new Capture();
    new MaskingSpanExporter(inner, {
      captureContent: true,
      mask: () => {
        throw new Error("bad mask");
      },
    }).export([errorSpan({ "input.value": "secret" }, "secret")], () => {});
    const [span] = inner.seen;
    expect("input.value" in span.attributes).toBe(false);
    expect(span.status.message).toBeUndefined();
    expect(span.status.code).toBe(2);
    expect(warn).toHaveBeenCalled();
  });

  it("keeps a number or boolean a mask returns as it is", () => {
    const inner = new Capture();
    new MaskingSpanExporter(inner, { captureContent: true, mask: () => 7 }).export(
      [errorSpan({ "input.value": "secret", "output.value": "x" }, "secret")],
      () => {},
    );
    expect(inner.seen[0].attributes["input.value"]).toBe(7);
    expect(inner.seen[0].status.message).toBe("7");
  });
});

describe("OTEL_RESOURCE_ATTRIBUTES", () => {
  async function resource(options: InitOptions = {}): Promise<Record<string, unknown>> {
    const exporter = start(options);
    await startAsCurrentSpan("s", () => {});
    const [span] = await finished(exporter);
    return span.resource.attributes;
  }

  it("merges every key onto the resource, as Python's Resource.create does", async () => {
    vi.stubEnv(
      "OTEL_RESOURCE_ATTRIBUTES",
      "deployment.environment.name=prod, team = a%20b ,malformed,cloud.region=eu-west-1",
    );
    const attributes = await resource({ serviceName: "svc" });
    expect(attributes["deployment.environment.name"]).toBe("prod");
    expect(attributes.team).toBe("a b");
    expect(attributes["cloud.region"]).toBe("eu-west-1");
    expect("malformed" in attributes).toBe(false);
  });

  it("lets the SDK's own keys win over the variable", async () => {
    vi.stubEnv(
      "OTEL_RESOURCE_ATTRIBUTES",
      "service.name=from-env,gen_ai.agent.name=env-agent,telemetry.distro.name=other",
    );
    const attributes = await resource({ serviceName: "svc", agentName: "planner" });
    expect(attributes["service.name"]).toBe("svc");
    expect(attributes["gen_ai.agent.name"]).toBe("planner");
    expect(attributes["telemetry.distro.name"]).toBe("glassflow-rius");
  });
});

describe("the unknown_service placeholder on the resource", () => {
  it("is not stamped as gen_ai.agent.name", async () => {
    const exporter = start();
    await startAsCurrentSpan("s", () => {});
    const [span] = await finished(exporter);
    expect(span.resource.attributes["service.name"]).toBe("unknown_service");
    expect("gen_ai.agent.name" in span.resource.attributes).toBe(false);
  });

  it("still stamps a named agent", async () => {
    const exporter = start({ serviceName: "svc" });
    await startAsCurrentSpan("s", () => {});
    const [span] = await finished(exporter);
    expect(span.resource.attributes["gen_ai.agent.name"]).toBe("svc");
  });
});

describe("blank RIUS_ENDPOINT / RIUS_SERVICE_NAME", () => {
  it("treats an empty value as unset", () => {
    const c = resolveConfig({}, { RIUS_ENDPOINT: "", RIUS_SERVICE_NAME: "" });
    expect(c.endpoint).toBe("https://ingest.eu.console.rius-glassflow.com");
    expect(c.serviceName).toBe("unknown_service");
    expect(c.agentName).toBe("unknown_service");
  });

  it("treats an empty option as unset too", () => {
    const c = resolveConfig(
      { endpoint: "", serviceName: "" },
      { RIUS_ENDPOINT: "https://e.example", RIUS_SERVICE_NAME: "svc" },
    );
    expect(c.endpoint).toBe("https://e.example");
    expect(c.serviceName).toBe("svc");
  });
});

describe("numeric environment variables", () => {
  for (const [name, raw, read, fallback] of [
    ["RIUS_SAMPLE_RATE", "0.5abc", (c) => c.sampleRate, 1],
    ["RIUS_SAMPLE_RATE", "", (c) => c.sampleRate, 1],
    ["RIUS_SAMPLE_RATE", "0x1", (c) => c.sampleRate, 1],
    ["RIUS_HEARTBEAT_INTERVAL", "10s", (c) => c.heartbeatIntervalMs, 15000],
    ["RIUS_PARTIAL_SPANS_DELAY", "5 seconds", (c) => c.partialSpansDelayMs, 0],
  ] as const satisfies readonly (readonly [
    string,
    string,
    (c: ReturnType<typeof resolveConfig>) => number,
    number,
  ])[]) {
    it(`rejects ${name}=${JSON.stringify(raw)} with a warning and uses the default`, () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(read(resolveConfig({}, { [name]: raw }))).toBe(fallback);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(name));
    });
  }

  it("accepts every form Python's float() does", () => {
    expect(resolveConfig({}, { RIUS_SAMPLE_RATE: " 0.5 " }).sampleRate).toBe(0.5);
    expect(resolveConfig({}, { RIUS_SAMPLE_RATE: ".25" }).sampleRate).toBe(0.25);
    expect(resolveConfig({}, { RIUS_SAMPLE_RATE: "5e-1" }).sampleRate).toBe(0.5);
    expect(resolveConfig({}, { RIUS_HEARTBEAT_INTERVAL: "+20." }).heartbeatIntervalMs).toBe(20000);
  });
});

describe("sampleRate option", () => {
  it("is clamped with a warning, like the environment variable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveConfig({ sampleRate: 5 }).sampleRate).toBe(1);
    expect(resolveConfig({ sampleRate: -1 }).sampleRate).toBe(0);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`treats ${value} as unset with a warning, so spans are still exported`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const exporter = start({ sampleRate: value });
      startSpan("s").end();
      expect(await finished(exporter)).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("sampleRate"));
    });
  }

  it("warns when the environment variable is out of range", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveConfig({}, { RIUS_SAMPLE_RATE: "5" }).sampleRate).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("RIUS_SAMPLE_RATE"));
  });
});

describe("a null role in rius.context.sizes", () => {
  it("is reported as user, whose bytes it already counts as", () => {
    const sizes = JSON.parse(
      contextSizes(
        undefined,
        [{ role: null, parts: [{ type: "text", content: "hi" }] }],
        undefined,
      ),
    );
    expect(sizes.input_messages).toEqual([{ role: "user", parts: [{ type: "text", bytes: 2 }] }]);
  });

  it("does the same for a message with no role to read", () => {
    const sizes = JSON.parse(contextSizes(undefined, ["hi"], undefined));
    expect(sizes.input_messages[0].role).toBe("user");
  });

  it("leaves the null role on the message itself", () => {
    expect(serializeMessages([{ role: null, content: "hi" }], "user")).toBe(
      '[{"role":null,"parts":[{"type":"text","content":"hi"}]}]',
    );
  });
});

describe("toInt, as Python's to_int reads a token count", () => {
  // Python's _count: a non-negative whole number, never a boolean. A string
  // goes through int() first, so only the integer it spells is read.
  for (const value of [
    true,
    false,
    12.9,
    -5,
    "-5",
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NaN,
    "12.9",
    "12.0",
    "1e3",
    "0x10",
    "",
    " ",
    "1__0",
    "_1",
    "1_",
    "12abc",
    "inf",
    "nan",
  ]) {
    it(`skips ${JSON.stringify(value) ?? String(value)}`, () => {
      expect(toInt([value])).toBeUndefined();
    });
  }

  for (const [value, expected] of [
    [12, 12],
    [12.0, 12],
    [0, 0],
    [-0, 0],
    ["12", 12],
    [" 12\n", 12],
    ["+12", 12],
    ["012", 12],
    ["1_000", 1000],
    ["-0", 0],
  ] as const) {
    const label = Object.is(value, -0) ? "-0" : JSON.stringify(value);
    it(`reads ${label} as ${expected}`, () => {
      expect(Object.is(toInt([value]), expected)).toBe(true);
    });
  }
});

describe("OTEL_RESOURCE_ATTRIBUTES prototype keys", () => {
  it("become own keys and pollute no prototype", () => {
    const attributes = otelResourceAttributes("__proto__=pp,constructor=cc,toString=ts");
    expect(Object.getPrototypeOf(attributes)).toBe(Object.prototype);
    expect(Object.hasOwn(attributes, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(attributes, "__proto__")?.value).toBe("pp");
    expect(attributes.constructor).toBe("cc");
    expect(attributes.toString).toBe("ts");
    const plain: Record<string, unknown> = {};
    expect(plain.pp).toBeUndefined();
    expect(Object.prototype.constructor).toBe(Object);
    expect(Object.prototype.toString).not.toBe("ts");
  });

  it("do not stand in for a key the variable did not set", () => {
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment.name=prod");
    const config = resolveConfig({});
    expect(config.serviceVersion).toBeUndefined();
    expect(config.operatorMainAgent).toEqual({
      id: undefined,
      name: undefined,
      description: undefined,
    });
  });
});

describe("setAttribute with an array holding an array or a mapping", () => {
  const m = (n: number) => `[stripped unknown ${n} bytes]`;

  for (const [label, value, written] of [
    ["a nested array beside a number", [[1, new Uint8Array(1)]], `[[1,"${m(1)}"]]`],
    ["a nested array of a byte object", [[new Uint8Array(1)]], `[["${m(1)}"]]`],
    ["a nested array beside null", [null, [1, new Uint8Array(1)]], `[null,[1,"${m(1)}"]]`],
    ["a nested array beside a string", ["x", [1, new Uint8Array(1)]], `["x",[1,"${m(1)}"]]`],
    ["a mapping holding a byte object", [{ k: new Uint8Array(2) }], `[{"k":"${m(2)}"}]`],
    ["nested strings", [["x"], ["y"]], '[["x"],["y"]]'],
  ] as const) {
    it(`writes ${label} as one JSON string, as Python does`, async () => {
      const exporter = start();
      startSpan("s")
        .setAttribute("k", value as unknown)
        .end();
      const [span] = await finished(exporter);
      expect(span.attributes.k).toBe(written);
    });
  }
});
