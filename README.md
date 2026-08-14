# @glassflow-ai/rius

OpenTelemetry-native tracing for AI agents and LLM applications.

Rius wraps the OpenTelemetry SDK with agent-shaped primitives: spans for
tool calls and chains, generations for LLM calls, and a function wrapper
that turns a plain `async` function into an instrumented one. Traces are
sent as OTLP over HTTP, so any OTLP-compatible backend can receive them.

> Status: alpha and unpublished (0.1.0). APIs may change before the first release.

## Install

```bash
npm install @glassflow-ai/rius @opentelemetry/api
```

`@opentelemetry/api` is a peer dependency and is never bundled. Install
it alongside `@glassflow-ai/rius` at a version satisfying `^1.9.0`.

## Quickstart

```ts
import {
  init,
  observe,
  startAsCurrentSpan,
  startAsCurrentGeneration,
  SpanKind,
} from "@glassflow-ai/rius";

const client = init({
  apiKey: process.env.RIUS_API_KEY, // or set RIUS_API_KEY
});

// Optional: wait for auto-instrumentations to finish attaching before the
// first span is created.
await client.ready;

// 1. Function wrapper — trace a whole call. Use a named function expression
//    (or pass { name }): an arrow function has no inferrable name and its
//    span would fall back to "anonymous".
const handle = observe(async function handle(query: string) {
  return await callModel(query);
});

// 2. Scoped span — trace a block
await startAsCurrentSpan(
  "retrieve",
  { kind: SpanKind.RETRIEVER, input: query },
  async (obs) => {
    const docs = await retrieveDocuments(query);
    obs.setOutput(docs);
    return docs;
  },
);

// 3. LLM generations — gen_ai-native
await startAsCurrentGeneration(
  "chat",
  { model: "gpt-4o", input: messages },
  async (gen) => {
    const reply = await callModel(messages);
    gen.setOutput(reply);
    gen.setUsage({ inputTokens: 42, outputTokens: 17 });
    return reply;
  },
);
```

Each surface has more detail below: `observe` for the function wrapper,
`startSpan`/`startAsCurrentSpan` for manual and scoped spans, and
`startGeneration`/`startAsCurrentGeneration` for LLM calls.

### `observe`: wrap a function

`observe` wraps a function so every call becomes a span. It always
returns a **promise**, even when the wrapped function is synchronous.

Use a named function expression (or pass `{ name }`) so the span gets a
real name. An arrow function has no inferrable name, and its span falls
back to `"anonymous"`:

```ts
import { observe } from "@glassflow-ai/rius";

const handleQuery = observe(async function handleQuery(query: string) {
  return await callModel(query);
});

// Equivalent, with an explicit name:
const handleQuery2 = observe(
  async (query: string) => callModel(query),
  { name: "handleQuery" },
);

await handleQuery("hello");
```

### `startSpan` / `startAsCurrentSpan`: manual spans

For finer control than `observe`, create spans directly:

```ts
import { startAsCurrentSpan } from "@glassflow-ai/rius";

await startAsCurrentSpan("fetch-documents", { input: query }, async (span) => {
  const docs = await fetchDocuments(query);
  span.setOutput(docs);
  return docs;
});
```

`startSpan` returns a handle you end yourself (or dispose with `using`);
`startAsCurrentSpan` runs a callback with the span active, ending it
automatically and recording any thrown exception. The options argument is
optional in both, so `startAsCurrentSpan("step", async (span) => { ... })`
works when you have nothing to configure.

On the manual path, `recordException()` does what the scoped form does for
you: it records the error and sets ERROR status.

```ts
const span = startSpan("fetch-documents");
try {
  span.setOutput(await fetchDocuments(query));
} catch (error) {
  span.recordException(error);
  throw error;
} finally {
  span.end();
}
```

### `startGeneration` / `startAsCurrentGeneration`: LLM calls

A `Generation` is a span specialised for LLM calls, with setters for the
gen_ai message and usage attributes:

```ts
import { startAsCurrentGeneration } from "@glassflow-ai/rius";

await startAsCurrentGeneration(
  "chat-completion",
  {
    model: "gpt-4o",
    provider: "openai",
    input: messages,
    modelParameters: { temperature: 0.2, max_tokens: 512 },
  },
  async (generation) => {
    const response = await client.chat.completions.create({ model: "gpt-4o", messages });
    generation.setOutput(response.choices[0]?.message);
    generation.setUsage({
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    });
    generation.setFinishReasons(response.choices[0]?.finish_reason ?? "stop");
    return response;
  },
);
```

Each `modelParameters` entry is recorded as `gen_ai.request.<key>`, so use the
provider's own parameter names. `setFinishReasons` accepts one reason or a
list.

## Auto-instrumentation

The SDK bundles five integrations. Each one is an optional peer
dependency: install the packages you need and `init()` enables whatever
it finds, so a plain `npm install @glassflow-ai/rius` patches nothing.

```bash
npm install @arizeai/openinference-instrumentation-openai @arizeai/openinference-instrumentation-anthropic @arizeai/openinference-instrumentation-langchain @arizeai/openinference-vercel @modelcontextprotocol/sdk
```

Install only the ones you use:

- **`openai`** wraps the OpenAI SDK, via `@arizeai/openinference-instrumentation-openai`, turning provider calls into spans.
- **`anthropic`** wraps the Anthropic SDK, via `@arizeai/openinference-instrumentation-anthropic`, turning Messages calls into LLM spans with model, messages and token counts.
- **`langchain`** traces LangChain.js chains, models, tools and retrievers, via `@arizeai/openinference-instrumentation-langchain`. It patches the callback manager in `@langchain/core`, which every LangChain.js application already has, and the SDK resolves that module for you so nothing has to be passed in at `init()`.
- **`vercel-ai`** attaches to spans the Vercel AI SDK's own OpenTelemetry integration produces, via `@arizeai/openinference-vercel`, adding OpenInference attributes to them. This package requires Node 22 or newer.
- **`mcp`** patches `@modelcontextprotocol/sdk`'s `Client.callTool` so every MCP tool call becomes a TOOL span, carrying the tool name, arguments, result, latency, and error status.

There is no selection option: `init()` always attempts every bundled
integration, so which ones actually attach is determined entirely by
which optional peers are installed. `client.ready` resolves with the
names that attached (for example `["openai", "mcp"]`) and never rejects,
even if every peer is missing or one of them is broken. A package that
is not installed stays quiet; a package that is installed but fails to
load logs a warning naming the integration and the underlying error, and
the SDK continues without it.

The `openai` and `anthropic` integrations work in both module systems:
CommonJS applications that `require` the provider SDK and pure-ESM
applications that `import` it are both patched, regardless of whether
the provider was loaded before or after `init()`. One combination is
not covered: the provider SDKs ship separate CommonJS and ESM builds,
and the instrumentation packages can patch only one of them per process
([Arize-ai/openinference#3557](https://github.com/Arize-ai/openinference/issues/3557)),
so exactly one build gets patched: the CommonJS build when anything in
the process `require`d the provider before `init()`, the ESM build
otherwise. Two combinations therefore stay uncovered until the
upstream fix lands: a CommonJS application whose *only* `require` of
the provider happens lazily after `init()` (requiring it anywhere
before `init()` avoids this), and — the mirror image — an ESM
application where some CommonJS dependency `require`d the provider
before `init()`, which wins the choice away from the ESM build the
application itself is calling. The `langchain`, `vercel-ai` and `mcp`
integrations attach differently and have no such edge.

Content captured by these integrations, prompts, tool arguments and
results, and so on, is covered by the same `mask` and `captureContent`
controls as our own spans, since sanitisation happens centrally at
export rather than per integration.

`disabled: true` now means no third-party patching happens at all: no
optional package is even imported, and `client.ready` resolves to an
empty array.

## Configuration

Options passed to `init()` take priority, then `RIUS_*` environment
variables, then the defaults below.

| Option           | Environment variable    | Default                                      |
| ---------------- | ------------------------ | --------------------------------------------- |
| `endpoint`        | `RIUS_ENDPOINT`          | `https://ingest.eu.console.rius-glassflow.com` |
| `apiKey`           | `RIUS_API_KEY`           | none                                          |
| `serviceName`      | `RIUS_SERVICE_NAME`      | `unknown_service`                             |
| `disabled`         | `RIUS_DISABLED`          | `false`                                       |
| `sampleRate`       | `RIUS_SAMPLE_RATE`       | `1.0`                                         |
| `captureContent`   | `RIUS_CAPTURE_CONTENT`   | `true`                                        |
| `mask`             | (options only)           | none                                          |
| `heartbeat`        | `RIUS_HEARTBEAT`         | `true`                                        |
| `heartbeatInterval` | `RIUS_HEARTBEAT_INTERVAL` | `15` (seconds; clamped 5-300)               |
| `agentName`        | `RIUS_AGENT_NAME`        | `serviceName`                                 |
| `partialSpans`     | `RIUS_PARTIAL_SPANS`     | `false`                                       |
| `partialSpansDelay` | `RIUS_PARTIAL_SPANS_DELAY` | `0` (seconds; clamped 0-60)                |

Traces are posted to `<endpoint>/v1/traces`.

`captureContent` controls whether input/output content (prompts,
completions, tool arguments) is attached to spans. It defaults to
`true`. Set it to `false`, or supply a `mask` function, if your spans
must not carry raw content. Both apply to span attributes and to the
attributes of span events and links. With `captureContent: false` the
message and stacktrace of a recorded exception are stripped as well,
since provider errors routinely echo the request back; the exception
event and its `exception.type` are kept, so failures stay visible.
`mask` does not extend that far: with `captureContent: true`, a `mask`
function scrubs content attributes on spans, events and links, but
exception messages, stacktraces and the status message pass through
unmasked, so a raw provider error can still reach your backend. Disable
`captureContent` if you need those scrubbed too.

`disabled` turns the SDK off completely: nothing is exported, and no
optional integration is loaded, so no third-party module is patched in your
process. `client.ready` resolves to an empty list. Spans can still be
created and are simply dropped.

## Agent liveness

Traces only leave the process when a span ends, so an idle-but-alive agent
and a crashed one look identical from the outside. Two independent
mechanisms close that gap: a heartbeat that reports the process is still
running, and partial spans that leave a durable trace of in-flight work if
the process disappears before finishing it.

### Heartbeat

With `heartbeat: true` (the default), the SDK posts to `<endpoint>/v1/heartbeat`
for the life of the process: an immediate first ping when `init()` runs,
then one every `heartbeatInterval` seconds (default 15, clamped to 5-300).
Each ping reports the count of currently open root spans, which is what
lets the backend tell a live-but-idle agent from one that has vanished.

The final ping, carrying `stopped: true`, is sent by `client.shutdown()`.
The SDK also makes a best-effort attempt to send it when the process ends
naturally, on Node's `beforeExit` event. An application that never calls
`shutdown()` and exits abruptly, killed, crashed, or via `process.exit()`,
misses that last ping and reports as gone rather than stopped, the same way
a hard-killed agent looks in any language. Call `client.shutdown()` on a
graceful exit if you want that distinction to show up.

The heartbeat never keeps the process alive, its timer is unref'd, and never
throws into your code; delivery failures are logged once per process and
silent after that. `agentName` identifies the agent in heartbeat payloads
and defaults to `serviceName`.

### Partial spans

With `partialSpans: true` (default `false`), every sampled span additionally
exports a content-free snapshot the moment it starts, on top of the normal
export when it ends. The snapshot carries only identity and taxonomy
attributes, trace id, span id, name and timestamps, never content, whatever
instrumentation set on the span. The backend stores it as an unfinished row
and replaces it with the real span at end, so a snapshot that is never
replaced is the durable record of what a crashed agent was doing.

`partialSpansDelay` (default `0`, clamped to 0-60 seconds) debounces the
snapshot: it is held for that long and only sent if the span is still open
once the delay elapses, so a span that finishes quickly costs zero network
calls.

## Reliability

Export is designed to never block or crash your application:

- **Async batched export.** Spans are queued in-process and exported in
  batches from a background timer via OpenTelemetry's `BatchSpanProcessor`.
  Span creation stays fast even when the backend is slow or unreachable.
- **Retries.** The OTLP/HTTP transport retries transient and retryable
  failures with exponential backoff and jitter, up to 5 attempts, bounded
  by the export timeout.
- **Graceful degradation.** If the backend stays unreachable, spans are
  dropped and the failure is logged, it is never raised into application
  code. Only the first export failure in a process is logged, naming
  `RIUS_API_KEY`/`RIUS_ENDPOINT` as the likely cause; later failures stay
  silent so a persistent outage does not spam your logs. `client.flush()`
  returns `false` when the most recent export failed, so you can check
  delivery explicitly instead of relying on logs alone.
- **Mask failures fail safe.** If a `mask` callback throws, the affected
  attribute value is replaced with the literal `"[mask error]"` rather
  than dropping the batch or letting the exception escape.
- **No automatic flush on exit.** The SDK does not register a process-exit
  hook. Call `client.flush()` to force a pending export, or
  `client.shutdown()` to drain the queue and tear the client down, before
  your process exits:

  ```ts
  await client.flush();
  await client.shutdown();
  ```

Batching is tunable via the standard OpenTelemetry env vars:
`OTEL_BSP_MAX_QUEUE_SIZE` (default 2048; spans beyond this are dropped),
`OTEL_BSP_SCHEDULE_DELAY` (default 5000 ms), `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`
(default 512), and `OTEL_BSP_EXPORT_TIMEOUT` (default 30000 ms).

## Development

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

## Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please)
and published to npm.

1. Merge changes to `main` using [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat:` → minor, `fix:` → patch, `feat!:`/`BREAKING CHANGE` → major).
2. release-please keeps a **Release PR** open that bumps the package
   version and updates the changelog. Merge it when you want to cut a
   release.
3. Merging the Release PR tags `vX.Y.Z`, creates a GitHub Release, and
   publishes to npm automatically using npm trusted publishing, no token
   required.

Non-conventional commits are ignored for versioning.

The package has not been published yet, so the very first release cannot
use trusted publishing: npm requires a package to already exist before
it can be linked to a trusted publisher. That first publish needs either
a one-time manual `npm publish` or a temporary `NPM_TOKEN` secret; once
the package exists on npm, trusted publishing takes over and the token
can be removed.

## License

MIT
