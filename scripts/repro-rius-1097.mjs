#!/usr/bin/env node
/**
 * Reproduce RIUS-1097: LLM spans exported with a parent Rius never receives.
 *
 * When another SDK registers the OpenTelemetry global tracer provider before
 * `rius.init()`, Rius keeps its own provider (the global is write-once) and
 * binds its instrumentations to it. Span CONTEXT, however, is process-wide: an
 * LLM call made inside a span of the foreign provider takes that span as its
 * parent. The LLM span reaches Rius, its parent goes to the foreign provider's
 * exporter, and the trace Rius receives is flat and rootless with exactly one
 * missing parent.
 *
 * Each case runs in its own subprocess, because the global provider can be set
 * only once per process:
 *
 * - `control`   Rius alone; the customer's job spans use the global = Rius.
 * - `remote`    as control, but every job continues a trace from an incoming
 *   `traceparent` header: a remote parent, which is never an orphan.
 * - `foreign`   a plain `NodeTracerProvider` claims the global first.
 * - `traceloop` Traceloop's OTel-based SDK is initialised first; it claims the
 *   global itself when none is set. Skipped when `@traceloop/node-server-sdk`
 *   is not installed. Rius runs with `captureContent: false` here, and each job
 *   records its input and output through Traceloop's own API (`withWorkflow`),
 *   carrying a sentinel string. The case fails as LEAKED if the sentinel
 *   reaches Rius's exporter anywhere, and is void unless Traceloop's own
 *   provider received it (proof the content was written).
 *
 * The fix (Rius bridges its pipeline onto a foreign global provider) is opt-in:
 * `foreign` and `traceloop` run with `--bridge`
 * (`bridgeForeignProvider: true`), which must give whole trees, and with the
 * default config, which must still orphan but DETECT it: every orphan flagged
 * `rius.parent.foreign`, counted in the heartbeat, and the conflict named on
 * the resource (UNDETECTED otherwise).
 *
 * Every case runs Rius with a session id and inside a `withUser()` scope. A
 * bridged case must carry both on the spans Rius exports from the other
 * provider (UNSTAMPED otherwise), and the other provider's own export must be
 * exactly what a `--baseline` run, the same workload without Rius, gives it
 * (FOREIGN-CHANGED otherwise): Rius never writes to a span it did not create.
 *
 * OpenAI and Anthropic are called through their real client libraries against a
 * local HTTP server answering canned bodies, so the bundled instrumentations
 * produce real LLM spans and nothing touches the network (Traceloop points at a
 * closed local port).
 *
 * Run (the build is what a customer imports; the Traceloop case needs the extra
 * package, which is deliberately not a dev dependency):
 *
 *     npm run build
 *     npm install --no-save --no-package-lock @traceloop/node-server-sdk
 *     node scripts/repro-rius-1097.mjs
 *
 * Exits 0 when every case gives its expected verdict (or is skipped), 1
 * otherwise (a single `--case` run exits 3 when ORPHANED, 4 when skipped, 5
 * when LEAKED, 6 when UNDETECTED, 7 when UNSTAMPED).
 */
import { spawnSync } from "node:child_process";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);

const JOBS = 5;
const LLM_CALLS_PER_JOB = 3;
const CASES = ["control", "remote", "foreign", "traceloop"];
/** [case, bridge on, expected verdict of the full run] */
const MATRIX = [
  ["control", false, "OK"],
  ["remote", false, "OK"],
  ["foreign", true, "OK"],
  ["traceloop", true, "OK"],
  ["foreign", false, "ORPHANED"],
  ["traceloop", false, "ORPHANED"],
];
const FOREIGN_CASES = ["foreign", "traceloop"];
const REMOTE_TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
const PARENT_FOREIGN = "rius.parent.foreign";
const GLOBAL_PROVIDER = "rius.sdk.global_provider";
const IDENTITY_KEYS = ["service.name", "service.instance.id", "gen_ai.agent.name"];
const EXIT_CODES = {
  OK: 0,
  ORPHANED: 3, // distinct from 1, which an uncaught exception also yields
  SKIPPED: 4,
  LEAKED: 5,
  UNDETECTED: 6,
  UNSTAMPED: 7,
};
const SENTINEL = "RIUS1097-CONTENT-SENTINEL";
const SESSION_ID = "repro-session";
const USER_ID = "repro-user";

// --------------------------------------------------------------------------- analysis

/** Every exported span's parent must be in the exported set. */
function analyse(spans) {
  const id = (context) => `${context.traceId}:${context.spanId}`;
  const known = new Set(spans.map((s) => id(s.spanContext())));
  const byTrace = new Map();
  for (const span of spans) {
    const trace = span.spanContext().traceId;
    byTrace.set(trace, [...(byTrace.get(trace) ?? []), span]);
  }
  const withParent = new Set(spans.filter((s) => s.parentSpanContext !== undefined));
  const resolved = new Set([...withParent].filter((s) => known.has(id(s.parentSpanContext))));
  const traces = [...byTrace.entries()].sort().map(([traceId, members]) => {
    const unresolved = members.filter((s) => withParent.has(s) && !resolved.has(s));
    // A REMOTE parent (continued from a `traceparent` header) is never expected
    // in the set and counts as the trace's root.
    const remote = unresolved.filter((s) => s.parentSpanContext.isRemote === true);
    const local = unresolved.filter((s) => s.parentSpanContext.isRemote !== true);
    const unique = (list) => [...new Set(list.map((s) => s.parentSpanContext.spanId))].sort();
    return {
      traceId,
      spans: members.length,
      hasRoot: remote.length > 0 || members.some((s) => s.parentSpanContext === undefined),
      missingParentIds: unique(local),
      remoteParentIds: unique(remote),
    };
  });
  const orphaned = traces.some((t) => t.missingParentIds.length > 0 || !t.hasRoot);
  return {
    totalSpans: spans.length,
    spansWithParent: withParent.size,
    parentsResolved: resolved.size,
    foreignFlagged: spans.filter((s) => s.attributes?.[PARENT_FOREIGN] === true).length,
    traces,
    orphaned,
    verdict: orphaned ? "ORPHANED" : "OK",
  };
}

function printReport(title, report) {
  console.log(`  ${title}`);
  console.log(`    total spans:               ${report.totalSpans}`);
  console.log(`    spans with a parent id:    ${report.spansWithParent}`);
  console.log(`    parents resolved in set:   ${report.parentsResolved}`);
  console.log(`    flagged ${PARENT_FOREIGN}: ${report.foreignFlagged}`);
  console.log(`    traces:                    ${report.traces.length}`);
  for (const t of report.traces) {
    const missing = t.missingParentIds.join(",") || "-";
    const remote = t.remoteParentIds.join(",") || "-";
    console.log(
      `    trace ${t.traceId.slice(0, 12)}  spans=${t.spans}  root=${String(t.hasRoot).padEnd(5)}  ` +
        `missing_parents=${t.missingParentIds.length} [${missing}]  remote_parent=${remote}`,
    );
  }
}

/** Whether every exported span carries the identity the sink reads off the resource. */
function printIdentity(spans, ownResource) {
  const wanted = IDENTITY_KEYS.map((key) => [key, ownResource.attributes[key]]);
  const off = spans.filter((s) =>
    wanted.some(([key, value]) => s.resource.attributes[key] !== value),
  );
  console.log(`    resource ${GLOBAL_PROVIDER}: ${ownResource.attributes[GLOBAL_PROVIDER] ?? "-"}`);
  console.log(
    `    spans lacking rius resource identity (${IDENTITY_KEYS.join(", ")}): ${off.length}`,
  );
}

/** Every orphan flagged, counted in the heartbeat, and the conflict on the resource. */
function detected(report, ownResource, ping) {
  const orphans = report.spansWithParent - report.parentsResolved;
  const conflict = String(ownResource.attributes[GLOBAL_PROVIDER] ?? "");
  return (
    orphans > 0 &&
    report.foreignFlagged === orphans &&
    ping?.foreign_parent_spans === orphans &&
    conflict.startsWith("foreign:")
  );
}

/** UNSTAMPED unless the bridged spans Rius exports carry the session and user. */
function stampVerdict(spans, verdict) {
  const bridged = spans.filter(
    (s) =>
      s.instrumentationScope.name !== "rius" &&
      !s.instrumentationScope.name.includes("openinference"),
  );
  const unstamped = bridged
    .filter((s) => s.attributes["session.id"] !== SESSION_ID || s.attributes["user.id"] !== USER_ID)
    .map((s) => s.name);
  console.log(
    `    bridged spans in rius's export: ${bridged.length}, missing session/user: [${unstamped}]`,
  );
  return unstamped.length > 0 || bridged.length === 0 ? "UNSTAMPED" : verdict;
}

function flat(value) {
  return (Array.isArray(value) ? value : [value]).map(String);
}

/** `span: key` for every attribute, event attribute or status carrying the sentinel. */
function leakedKeys(spans) {
  const leaks = [];
  for (const span of spans) {
    const mappings = [span.attributes ?? {}, ...span.events.map((e) => e.attributes ?? {})];
    for (const mapping of mappings) {
      for (const [key, value] of Object.entries(mapping)) {
        if (flat(value).some((v) => v.includes(SENTINEL))) leaks.push(`${span.name}: ${key}`);
      }
    }
    if ((span.status.message ?? "").includes(SENTINEL)) leaks.push(`${span.name}: status.message`);
  }
  return leaks;
}

/** LEAKED if the sentinel reached Rius; VOID if nothing ever wrote it. */
function contentVerdict(spans, foreignExporter, verdict) {
  const written =
    foreignExporter !== undefined && leakedKeys(foreignExporter.getFinishedSpans()).length > 0;
  const leaks = leakedKeys(spans);
  console.log("  captureContent=false:");
  console.log(`    sentinel written to the foreign provider's spans: ${written}`);
  console.log(`    sentinel in rius's export: ${leaks.length} attribute(s)`);
  for (const leak of leaks) console.log(`      ${leak}`);
  if (!written) return "VOID";
  return leaks.length > 0 ? "LEAKED" : verdict;
}

function printForeign(spans) {
  console.log(`  foreign provider received ${spans.length} span(s):`);
  for (const s of spans) {
    const context = s.spanContext();
    console.log(`    ${s.name.padEnd(8)} trace ${context.traceId}  span_id=${context.spanId}`);
  }
}

/** One line the parent compares against the `--baseline` run. */
function printForeignAttributes(spans) {
  const attributes = spans.map((s) => JSON.stringify([s.name, s.attributes])).sort();
  console.log(`FOREIGN ${JSON.stringify(attributes)}`);
}

// --------------------------------------------------------------------------- mocked LLMs

const OPENAI_BODY = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 0,
  model: "gpt-4o-mini",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};
const ANTHROPIC_BODY = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 1 },
};

/** A local server answering every provider request with a canned body. */
async function mockProviders() {
  const server = http.createServer((request, response) => {
    const body = request.url.includes("/messages") ? ANTHROPIC_BODY : OPENAI_BODY;
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

function llmCalls(url) {
  // Required (not imported) and loaded before init(), as most applications do:
  // the instrumentations patch the module registry.
  const { OpenAI } = require("openai");
  const Anthropic = require("@anthropic-ai/sdk").default;
  const openai = new OpenAI({ apiKey: "test", baseURL: `${url}/v1`, maxRetries: 0 });
  const anthropic = new Anthropic({ apiKey: "test", baseURL: url, maxRetries: 0 });
  const messages = [{ role: "user", content: `hi ${SENTINEL}` }];
  return [
    () => openai.chat.completions.create({ model: "gpt-4o-mini", messages }),
    () => anthropic.messages.create({ model: "claude-sonnet-4-5", max_tokens: 8, messages }),
  ];
}

/** The customer's workload: each job span wraps a few LLM calls, for one user. */
async function runJobs(startJob, providers, withUser) {
  const calls = llmCalls(providers.url);
  for (let job = 0; job < JOBS; job++) {
    await withUser(USER_ID, () =>
      startJob(job, async () => {
        for (let n = 0; n < LLM_CALLS_PER_JOB; n++) await calls[n % calls.length]();
      }),
    );
  }
}

// --------------------------------------------------------------------------- cases

/** The job span the customer starts through the OpenTelemetry global. */
function globalJob(trace) {
  return (job, body) =>
    trace.getTracer("customer.jobs").startActiveSpan(`job-${job}`, async (span) => {
      try {
        await body();
      } finally {
        span.end();
      }
    });
}

/** As `globalJob`, but every job continues a trace from an incoming header. */
function remoteJob(trace, { context, propagation, ROOT_CONTEXT, defaultTextMapGetter }) {
  return (job, body) => {
    const incoming = propagation.extract(
      ROOT_CONTEXT,
      { traceparent: REMOTE_TRACEPARENT },
      defaultTextMapGetter,
    );
    return context.with(incoming, () => globalJob(trace)(job, body));
  };
}

/** A job recording its content the way a Traceloop user would, sentinel in each. */
function traceloopJob(traceloop) {
  return (job, body) =>
    traceloop.withWorkflow(
      { name: `job-${job}` },
      async () => {
        await body();
        return { answer: `96,450,000 ${SENTINEL}` };
      },
      { label: `job-${job} ${SENTINEL}`, note: `customer payload ${SENTINEL}` },
    );
}

async function importRius() {
  try {
    return await import(new URL("../dist/index.js", import.meta.url).href);
  } catch (error) {
    console.error(`  cannot import ../dist: run \`npm run build\` first (${error.message})`);
    process.exit(2);
  }
}

async function runCase(name, { bridge, baseline }) {
  const { trace, context, propagation, ROOT_CONTEXT, defaultTextMapGetter } = await import(
    "@opentelemetry/api"
  );
  const { InMemorySpanExporter, SimpleSpanProcessor } = await import(
    "@opentelemetry/sdk-trace-base"
  );
  const { NodeTracerProvider } = await import("@opentelemetry/sdk-trace-node");
  const rius = await importRius();

  let foreignExporter;
  let startJob = globalJob(trace);

  if (name === "remote") {
    startJob = remoteJob(trace, { context, propagation, ROOT_CONTEXT, defaultTextMapGetter });
  } else if (name === "foreign") {
    foreignExporter = new InMemorySpanExporter();
    const foreign = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(foreignExporter)],
    });
    foreign.register();
  } else if (name === "traceloop") {
    let traceloop;
    try {
      traceloop = await import("@traceloop/node-server-sdk");
    } catch {
      console.log(
        "  SKIPPED: @traceloop/node-server-sdk not installed (npm install --no-save --no-package-lock @traceloop/node-server-sdk)",
      );
      return EXIT_CODES.SKIPPED;
    }
    foreignExporter = new InMemorySpanExporter();
    traceloop.initialize({
      apiKey: "test",
      baseUrl: "http://127.0.0.1:9",
      disableBatch: true,
      // Leave the LLM clients to Rius's own instrumentation: this case is about
      // the job spans Traceloop owns, not about whose OpenAI patch wins.
      instrumentModules: {},
      exporter: foreignExporter,
    });
    const global = trace.getTracerProvider();
    const delegate = global.getDelegate?.() ?? global;
    console.log(`  global provider after traceloop.initialize(): ${delegate.constructor?.name}`);
    startJob = traceloopJob(traceloop);
  }

  const providers = await mockProviders();
  try {
    if (baseline) {
      await runJobs(startJob, providers, (_user, fn) => fn());
      await new Promise((resolve) => setTimeout(resolve, 200));
      printForeignAttributes(foreignExporter.getFinishedSpans());
      return 0;
    }

    const exporter = new InMemorySpanExporter();
    const pings = [];
    const captureContent = name !== "traceloop";
    const client = rius.init({
      endpoint: "http://rius.invalid",
      apiKey: "test",
      serviceName: "rius-1097-repro",
      spanExporter: exporter,
      heartbeat: true,
      heartbeatTransport: async (payload) => {
        pings.push(payload);
      },
      partialSpans: false,
      sessionId: SESSION_ID,
      captureContent,
      // Only when asked, so the default runs exercise the real default.
      ...(bridge ? { bridgeForeignProvider: true } : {}),
    });
    await client.ready;
    await runJobs(startJob, providers, rius.withUser);
    await client.flush();

    // Read the export before shutdown: InMemorySpanExporter.shutdown() resets it.
    const spans = exporter.getFinishedSpans();
    const foreignSpans = foreignExporter?.getFinishedSpans() ?? [];
    const ownResource = spans[0]?.resource;
    await client.shutdown();

    const report = analyse(spans);
    printReport("spans rius exported:", report);
    printIdentity(spans, ownResource);
    console.log(
      `    heartbeat foreign_parent_spans (final ping): ${pings.at(-1)?.foreign_parent_spans}`,
    );
    if (foreignExporter !== undefined) {
      printForeign(foreignSpans);
      printForeignAttributes(foreignSpans);
    }

    let verdict = report.verdict;
    if (verdict === "ORPHANED" && !detected(report, ownResource, pings.at(-1))) {
      verdict = "UNDETECTED";
    }
    if (bridge && foreignExporter !== undefined) verdict = stampVerdict(spans, verdict);
    if (!captureContent) verdict = contentVerdict(spans, foreignExporter, verdict);
    const label = bridge ? `${name} --bridge` : name;
    console.log(`  VERDICT[${label}]: ${verdict}`);
    return EXIT_CODES[verdict] ?? 1;
  } finally {
    providers.close();
  }
}

// --------------------------------------------------------------------------- driver

/** Run one case in a subprocess, echoing its output; returns [exit code, stdout]. */
function runChild(args) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    encoding: "utf8",
  });
  process.stdout.write(child.stdout ?? "");
  process.stderr.write(child.stderr ?? "");
  return [child.status, child.stdout ?? ""];
}

function foreignLine(stdout) {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("FOREIGN "))
    .at(-1);
}

/** The verdict of one case; a bridged foreign case is also checked against its baseline. */
function runMatrixCase(name, bridge) {
  const [code, stdout] = runChild(["--case", name, ...(bridge ? ["--bridge"] : [])]);
  const verdicts = Object.fromEntries(Object.entries(EXIT_CODES).map(([k, v]) => [v, k]));
  const actual = verdicts[code] ?? `ERROR(exit ${code})`;
  if (!bridge || !FOREIGN_CASES.includes(name) || actual === "SKIPPED") return actual;
  console.log(`=== baseline: ${name} without rius`);
  const [, baseline] = runChild(["--case", name, "--baseline"]);
  const line = foreignLine(stdout);
  const same = line !== undefined && line === foreignLine(baseline);
  console.log(`  foreign provider's export identical to the baseline without rius: ${same}`);
  return same ? actual : "FOREIGN-CHANGED";
}

const { values } = parseArgs({
  options: {
    case: { type: "string" },
    bridge: { type: "boolean", default: false },
    baseline: { type: "boolean", default: false },
  },
});

if (values.case !== undefined) {
  if (!CASES.includes(values.case)) {
    console.error(`--case must be one of ${CASES.join(", ")}`);
    process.exit(2);
  }
  process.exitCode = await runCase(values.case, {
    bridge: values.bridge,
    baseline: values.baseline,
  });
} else {
  const results = MATRIX.map(([name, bridge, expected]) => {
    const label = bridge ? `${name} --bridge` : name;
    console.log(`=== case: ${label}`);
    return [label, expected, runMatrixCase(name, bridge)];
  });
  console.log("=== summary");
  let ok = true;
  for (const [label, expected, actual] of results) {
    const asExpected = actual === expected || actual === "SKIPPED";
    ok = ok && asExpected;
    const mark = asExpected ? "as expected" : `UNEXPECTED (want ${expected})`;
    console.log(`  ${label.padEnd(22)} ${actual.padEnd(15)} ${mark}`);
  }
  process.exitCode = ok ? 0 : 1;
}
