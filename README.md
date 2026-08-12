# @glassflow/rius

OpenTelemetry-native tracing for AI agents and LLM applications.

Rius wraps the OpenTelemetry SDK with agent-shaped primitives: spans for
tool calls and chains, generations for LLM calls, and a function wrapper
that turns a plain `async` function into an instrumented one. Traces are
sent as OTLP over HTTP, so any OTLP-compatible backend can receive them.

## Install

```bash
npm install @glassflow/rius @opentelemetry/api
```

`@opentelemetry/api` is a peer dependency and is never bundled. Install
it alongside `@glassflow/rius` at a version satisfying `^1.9.0`.

## Quickstart

Call `init()` once, at startup:

```ts
import { init } from "@glassflow/rius";

const client = init({
  apiKey: process.env.RIUS_API_KEY,
});

// Optional: wait for auto-instrumentations (OpenAI, Vercel AI SDK, MCP)
// to finish attaching before the first span is created.
await client.ready;
```

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
automatically and recording any thrown exception.

### `startGeneration` / `startAsCurrentGeneration`: LLM calls

A `Generation` is a span specialised for LLM calls, with setters for the
gen_ai message and usage attributes:

```ts
import { startAsCurrentGeneration } from "@glassflow/rius";

await startAsCurrentGeneration(
  "chat-completion",
  { model: "gpt-4o", provider: "openai", input: messages },
  async (generation) => {
    const response = await client.chat.completions.create({ model: "gpt-4o", messages });
    generation.setOutput(response.choices[0]?.message);
    generation.setUsage({
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    });
    return response;
  },
);
```

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
must not carry raw content.

## Shutdown

Call `flush()` before your process exits to drain any queued spans, and
`shutdown()` to tear the client down:

```ts
await client.flush();
await client.shutdown();
```

## License

Apache-2.0
