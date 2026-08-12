# @glassflow/rius

OpenTelemetry-native tracing for AI agents and LLM applications.

Rius wraps the OpenTelemetry SDK with agent-shaped primitives: spans for
tool calls and chains, generations for LLM calls, and a function wrapper
that turns a plain `async` function into an instrumented one. Traces are
sent as OTLP over HTTP, so any OTLP-compatible backend can receive them.

> Status: alpha and unpublished (0.1.0). APIs may change before the first release.

## Install

```bash
npm install @glassflow/rius @opentelemetry/api
```

`@opentelemetry/api` is a peer dependency and is never bundled. Install
it alongside `@glassflow/rius` at a version satisfying `^1.9.0`.

## Quickstart

```ts
import {
  init,
  observe,
  startAsCurrentSpan,
  startAsCurrentGeneration,
  SpanKind,
} from "@glassflow/rius";

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
import { observe } from "@glassflow/rius";

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
import { startAsCurrentSpan } from "@glassflow/rius";

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
import { startAsCurrentGeneration } from "@glassflow/rius";

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

The SDK bundles three integrations. Each one is an optional peer
dependency: install the packages you need and `init()` enables whatever
it finds, so a plain `npm install @glassflow/rius` patches nothing.

```bash
npm install @arizeai/openinference-instrumentation-openai @arizeai/openinference-vercel @modelcontextprotocol/sdk
```

Install only the ones you use:

- **`openai`** wraps the OpenAI SDK, via `@arizeai/openinference-instrumentation-openai`, turning provider calls into spans.
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

Traces are posted to `<endpoint>/v1/traces`.

`captureContent` controls whether input/output content (prompts,
completions, tool arguments) is attached to spans. It defaults to
`true`. Set it to `false`, or supply a `mask` function, if your spans
must not carry raw content. Both apply to span attributes and to the
attributes of span events and links. With `captureContent: false` the
message of a recorded exception is stripped as well, since provider errors
routinely echo the request back; the exception event and its
`exception.type` are kept, so failures stay visible.

`disabled` turns the SDK off completely: nothing is exported, and no
optional integration is loaded, so no third-party module is patched in your
process. `client.ready` resolves to an empty list. Spans can still be
created and are simply dropped.

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

Apache-2.0
