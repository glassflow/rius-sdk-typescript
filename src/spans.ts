import {
  type Attributes,
  type SpanKind as OtelSpanKind,
  type Span,
  SpanStatusCode,
} from "@opentelemetry/api";
import { executingAgentName, resolveAgentName, withAgentScope } from "./agent.js";
import { getTracer } from "./client.js";
import {
  ERROR_TYPE,
  GEN_AI_AGENT_ID,
  GEN_AI_AGENT_NAME,
  GEN_AI_AGENT_VERSION,
  GEN_AI_DATA_SOURCE_ID,
  GEN_AI_RETRIEVAL_DOCUMENTS,
  GEN_AI_RETRIEVAL_TOP_K,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_TYPE,
  INPUT_VALUE,
  OUTPUT_VALUE,
  SpanKind,
  USER_ID,
  composeSpanName,
  kindAttributes,
  otelSpanKind,
} from "./semconv.js";
import { attributeValue, errorType, toAttributeValue } from "./serde.js";
import { withUser } from "./user.js";

/** Options for {@link startSpan} and {@link startAsCurrentSpan}. */
export interface SpanOptions {
  kind?: SpanKind;
  /**
   * The OpenTelemetry `SpanKind` FIELD (INTERNAL, CLIENT, …), orthogonal to
   * `kind` above, which is our taxonomy attribute. Conventions set it per
   * operation, so by default it is derived from `kind` (see `otelSpanKind`);
   * set this to override, as the MCP wrapper does for a remote tool call.
   */
  otelKind?: OtelSpanKind;
  input?: unknown;
  /**
   * End-user identity (`user.id`). Sugar for `withUser`: set on this span at
   * creation and, for the scoped variant, on every span opened inside it.
   * To attribute a whole request, including auto-instrumented spans, prefer
   * `withUser` around the handler.
   */
  userId?: string;
  /**
   * The tool name a TOOL span carries as `gen_ai.tool.name`. Defaults to the
   * span name, which is what a caller who passes nothing meant back when the
   * two were necessarily the same string. Pass it explicitly whenever the
   * span name is not the bare tool name — and prefer passing it INSTEAD of a
   * span name, which gets you the conventions' `execute_tool {tool}` name for
   * free. With neither, the span is named `execute_tool` and carries no tool
   * name: nothing is invented.
   */
  toolName?: string;
  /**
   * The id of the model's tool-call message this TOOL span answers, set as
   * `gen_ai.tool.call.id`. Caller-supplied and nothing else: the id belongs
   * to the assistant turn that requested the call, which the SDK never sees,
   * so there is nothing to derive it from and it is omitted rather than
   * invented. Scoped to TOOL, like `toolName`: on any other kind the key
   * would claim a tool call that is not there.
   */
  toolCallId?: string;
  /**
   * What kind of tool this TOOL span ran, set as `gen_ai.tool.type` — the
   * conventions' examples are `"function"`, `"extension"` and `"datastore"`.
   * Caller-supplied, recorded verbatim, never guessed from the callable: a
   * wrapped function is not automatically a `function` tool, since the same
   * wrapper is what an agent-side extension call goes through. Scoped to
   * TOOL, like `toolCallId`.
   */
  toolType?: string;
  /**
   * The index, collection or knowledge base a RETRIEVER span searched, set as
   * `gen_ai.data_source.id`. Ignored on every other kind: the key means the
   * target of a retrieval, and putting it elsewhere would make the attribute
   * mean something different depending on the span. Omitted when not passed,
   * never guessed.
   */
  dataSourceId?: string;
  /**
   * How many documents a RETRIEVER span asked for, set as
   * `gen_ai.retrieval.top_k`. Ignored on every other kind. What came back is
   * not an option here: it is unknown at span creation, so it is recorded
   * afterwards with `Observation.setRetrievedDocuments`.
   */
  topK?: number;
  /**
   * The agent an AGENT span INVOKES, set as `gen_ai.agent.name`. That is what
   * the key means on an invoke-agent span, where the conventions make it
   * Conditionally Required; on an execute-tool span the same key means the
   * agent DOING the call, which is why this is scoped to AGENT here. Unset,
   * it falls back to the agent name `init()` was given. It is never taken
   * from the span name, unlike the tool name: that fallback exists only
   * because a tool's name and its span name were historically one string,
   * and a wrong agent name mislabels every span beneath it. Ignored on every
   * other kind, where the key would read as "the agent that produced this
   * span" — which is what the resource attribute of the same name says.
   *
   * On the scoped surface this name also becomes the enclosing agent scope,
   * so TOOL spans opened inside the callback carry it as the agent that
   * EXECUTED them. See {@link startAsCurrentSpan}.
   */
  agentName?: string;
  /**
   * The invoked agent's identifier, set as `gen_ai.agent.id`. This key is for
   * a HOSTED agent resource, such as a Bedrock agent ARN; the conventions
   * advise against recording a transient in-memory instance id there, so an
   * in-process agent leaves it unset. Ignored on every other kind.
   */
  agentId?: string;
  /**
   * The invoked agent's version, set as `gen_ai.agent.version`: the version of
   * the agent DEFINITION this span invoked — its prompt, tools and policy.
   * Taken verbatim; the conventions' own examples are `1.0.0` and
   * `2025-05-01`, so there is no one format to hold callers to.
   *
   * Never derived from `service.version` (the build running this process) nor
   * from the main-agent version (the agent this process IS): a process at one
   * version can invoke agents at several others. Ignored on every other kind,
   * like the name and the id it accompanies.
   */
  agentVersion?: string;
  /**
   * Identity attributes to set at span CREATION rather than after it. Pending
   * snapshots are built at start, so anything a caller would otherwise
   * `setAttribute` first thing (a tool name, say) belongs here to reach them.
   * Content never does: it is not known at start and would bypass masking's
   * assumptions about where content lives.
   */
  attributes?: Record<string, string>;
}

// `Symbol.dispose` is undefined on Node 18.0 to 18.17 (added in 18.18 / 20.4)
// and `engines` allows >=18. Without it the method below would be keyed
// "undefined" and `using` would throw "not disposable". The TS helper falls
// back to this same well-known symbol, so installing it here keeps both sides
// agreeing; on newer Node it is already defined and this is a no-op.
(Symbol as { dispose?: symbol }).dispose ??= Symbol.for("Symbol.dispose");

/** A handle over a span. Chainable setters; `end()` is idempotent. */
export class Observation {
  protected ended = false;

  constructor(readonly span: Span) {}

  setInput(value: unknown): this {
    this.span.setAttribute(INPUT_VALUE, toAttributeValue(value));
    return this;
  }

  setOutput(value: unknown): this {
    this.span.setAttribute(OUTPUT_VALUE, toAttributeValue(value));
    return this;
  }

  /**
   * Record what a retrieval returned, as `gen_ai.retrieval.documents`.
   *
   * The conventions define this as an array of objects, each with an optional
   * `id` and an optional `score`. Identifiers and relevance, never document
   * text, which is why it is not treated as content: it survives
   * `captureContent: false` the way token counts do. Put the retrieved text in
   * `setOutput` if you want it captured, and masking applies to it there.
   *
   * Unlike `dataSourceId` and `topK`, which describe the request and are
   * passed at span creation, this is only knowable once the search has run, so
   * it never reaches a pending snapshot.
   */
  setRetrievedDocuments(documents: unknown): this {
    this.span.setAttribute(GEN_AI_RETRIEVAL_DOCUMENTS, toAttributeValue(documents));
    return this;
  }

  /**
   * Set an arbitrary attribute. Primitives and homogeneous primitive arrays
   * are passed through as the OTel values they are; objects are JSON-encoded
   * and bounded; `undefined` and `null` set nothing, since "no value" is not
   * an empty string.
   */
  setAttribute(key: string, value: unknown): this {
    const coerced = attributeValue(value);
    if (coerced !== undefined) this.span.setAttribute(key, coerced);
    return this;
  }

  /**
   * Record an error on the span, set ERROR status and `error.type`. This is
   * exactly what the `startAsCurrent*` helpers do on a thrown error, exposed
   * so the manual `start*` path does not have to reach through `.span` to
   * match it.
   *
   * `error.type` is Conditionally Required by the GenAI conventions on every
   * span that ends in an error, and every helper's throw path funnels through
   * here, so this is the one place that sets it. The error's name only, never
   * the message: it must stay low-cardinality and free of echoed content.
   *
   * Accepts `unknown` because that is what a `catch` binding is; a non-Error
   * throwable is wrapped so `recordException` still gets a real Error.
   */
  recordException(error: unknown): this {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    this.span.recordException(wrapped);
    this.span.setStatus({ code: SpanStatusCode.ERROR, message: wrapped.message });
    this.span.setAttribute(ERROR_TYPE, errorType(error));
    return this;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.span.end();
  }

  /** Lets callers write `using obs = startSpan(...)`. Sugar over end(). */
  [Symbol.dispose](): void {
    this.end();
  }
}

function configure(observation: Observation, options: SpanOptions): Observation {
  if (options.input !== undefined) observation.setInput(options.input);
  return observation;
}

/**
 * The tool's identity: explicit `toolName`, else the span name.
 *
 * Every comparable decorator in the ecosystem resolves tool identity as
 * "explicit name, else function name", feeding one value to both the span name
 * and the tool attribute, so a custom name on a tool-kind span names the tool
 * rather than merely labelling it. Dropping that would silently rename the tool
 * of every caller who passed a name, and `gen_ai.tool.name` is Required as a
 * dimension on the execute-tool duration histogram, so the rename splits their
 * series with no error anywhere.
 *
 * The contamination this guards against is unaffected: what must never feed the
 * attribute is the RENDERED `execute_tool {tool}` form, and this reads the
 * caller's own string, never the rendered one.
 *
 * The fallback warns once per span so the coupling is visible and a major
 * release can drop it without a silent rename. Passing `toolName` silences it.
 */
function resolveToolName(options: SpanOptions, name: string | undefined): string | undefined {
  if (options.toolName !== undefined) return options.toolName;
  // Nothing to fall back to: a caller who named neither the span nor the tool
  // gets the bare `execute_tool` name and no tool attribute, which is honest.
  // Nothing to warn about either, since no name is being reused as one.
  if (name === undefined) return undefined;
  if (options.kind === SpanKind.TOOL) {
    warnOnce(
      `A span named "${name}" with kind TOOL is naming the tool as well as the span; gen_ai.tool.name will be "${name}". Pass toolName to set them separately. A future major release will stop deriving the tool name from the span name.`,
    );
  }
  return name;
}

/** One warning per distinct message; a per-span warning would flood a loop. */
const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[rius] ${message}`);
}

/**
 * Identity attributes at CREATION so pending snapshots (onStart) carry them.
 * The user id is set here as well as via the `withUser` scope so it reaches
 * the span even on a provider without `UserSpanProcessor` installed.
 */
function creationAttributes(
  name: string | undefined,
  options: SpanOptions,
): Record<string, string | number> {
  const kind = options.kind ?? SpanKind.CHAIN;
  const attributes: Record<string, string | number> = {
    ...kindAttributes(kind, resolveToolName(options, name)),
    ...options.attributes,
  };
  if (options.userId !== undefined) attributes[USER_ID] = options.userId;
  if (kind === SpanKind.RETRIEVER) {
    if (options.dataSourceId !== undefined)
      attributes[GEN_AI_DATA_SOURCE_ID] = options.dataSourceId;
    if (options.topK !== undefined) attributes[GEN_AI_RETRIEVAL_TOP_K] = options.topK;
  }
  if (kind === SpanKind.TOOL) {
    // `gen_ai.agent.name` on an execute-tool span is Conditionally Required
    // and means something else than it does on the AGENT span above: the
    // agent EXECUTING the tool, not the one being invoked. It is read from
    // the enclosing AGENT scope, falling back to the configured agent.
    //
    // Read here, in the TOOL branch, rather than stamped on every span by a
    // processor: the conventions give this key no meaning on a chat,
    // retrieval or chain span, where it would read as "the agent that
    // produced this span" — a claim the resource attribute of the same name
    // already makes, and one the sink would then see twice with two
    // meanings.
    const executedBy = executingAgentName();
    if (executedBy !== undefined) attributes[GEN_AI_AGENT_NAME] = executedBy;
    // Caller-supplied tool-call identity. Set here with the tool name so it
    // reaches pending snapshots, and only on TOOL for the same reason the
    // agent name is read only here: neither key means anything on a chat,
    // retrieval or chain span. Neither has a fallback — an absent value is
    // absent, not defaulted.
    if (options.toolCallId !== undefined) attributes[GEN_AI_TOOL_CALL_ID] = options.toolCallId;
    if (options.toolType !== undefined) attributes[GEN_AI_TOOL_TYPE] = options.toolType;
  }
  if (kind === SpanKind.AGENT) {
    const agentName = resolveAgentName(options.agentName, kind);
    if (agentName !== undefined) attributes[GEN_AI_AGENT_NAME] = agentName;
    if (options.agentId !== undefined) attributes[GEN_AI_AGENT_ID] = options.agentId;
    if (options.agentVersion !== undefined) attributes[GEN_AI_AGENT_VERSION] = options.agentVersion;
  }
  return attributes;
}

/**
 * The span's name: the caller's if they gave one, else the conventions'
 * `{operation} {target}` form composed from the attributes this span is being
 * created with.
 *
 * Composing from the attributes rather than from the options is what keeps a
 * name and the span under it in agreement — the tool name has already been
 * resolved, the agent name has already fallen back to the configured one —
 * and it is also why the rendered string can never leak back into an
 * attribute: this reads the map, it never writes to it.
 */
function resolveName(
  name: string | undefined,
  kind: SpanKind | undefined,
  attributes: Record<string, string | number>,
): string {
  return name ?? composeSpanName(kind ?? SpanKind.CHAIN, attributes);
}

/**
 * Unpick `(name?, options?, fn)` from the scoped helpers' overload set, where
 * everything but the trailing callback is optional. Shared with the
 * generation helpers, whose options type differs but whose shape does not.
 *
 * Runtime discrimination is by `typeof`, which is exact here: a name is a
 * string, a body is a function, and an options bag is neither. The casts
 * only restate what those checks proved — TypeScript cannot narrow an
 * unresolved generic through `typeof`.
 *
 * @internal Not re-exported from the package entry point.
 */
export function splitScopedArgs<O extends object, F>(
  first: string | O | F,
  second?: O | F,
  third?: F,
): { name: string | undefined; options: O; fn: F } {
  if (typeof first === "function") return { name: undefined, options: {} as O, fn: first as F };
  if (typeof first === "string") {
    return typeof second === "function"
      ? { name: first, options: {} as O, fn: second as F }
      : { name: first, options: (second ?? {}) as O, fn: third as F };
  }
  return { name: undefined, options: first as O, fn: second as F };
}

/**
 * Create a span and return a handle. You MUST call end() (or use `using`).
 * The span is parented to whatever is current but does NOT become current.
 *
 * Because it never becomes current, an AGENT span created here opens no
 * agent scope: a TOOL span started while it is open falls back to the
 * configured agent name for `gen_ai.agent.name` rather than naming this one.
 * Use {@link startAsCurrentSpan} (or `observe`) where that matters.
 *
 * The name is optional: omit it and the span is named the way the GenAI
 * conventions say to, `{operation} {target}` — `execute_tool get_weather`,
 * `invoke_agent planner`, `retrieval docs-index` — from the attributes it is
 * being created with. A name you pass always wins.
 */
export function startSpan(name: string, options?: SpanOptions): Observation;
export function startSpan(options?: SpanOptions): Observation;
export function startSpan(
  nameOrOptions?: string | SpanOptions,
  maybeOptions?: SpanOptions,
): Observation {
  const [name, options] =
    typeof nameOrOptions === "string"
      ? [nameOrOptions, maybeOptions ?? {}]
      : [undefined, nameOrOptions ?? {}];

  const attributes = creationAttributes(name, options);
  const span = getTracer().startSpan(resolveName(name, options.kind, attributes), {
    kind: options.otelKind ?? otelSpanKind(options.kind ?? SpanKind.CHAIN),
    attributes,
  });
  return configure(new Observation(span), options);
}

/** The body of a scoped span. */
export type SpanBody<T> = (observation: Observation) => Promise<T> | T;

/**
 * Run `fn` with a new span active, so spans created inside it nest under this
 * one across async boundaries. Auto-ends, records exceptions, rethrows.
 *
 * Both the name and `options` are optional, and the callback always comes
 * last: `startAsCurrentSpan(name, fn)`, `startAsCurrentSpan(options, fn)` and
 * `startAsCurrentSpan(fn)` all work, as does the full three-argument form.
 * Omitting the name asks for the conventions' `{operation} {target}` name;
 * see {@link startSpan}.
 */
export function startAsCurrentSpan<T>(name: string, fn: SpanBody<T>): Promise<T>;
export function startAsCurrentSpan<T>(
  name: string,
  options: SpanOptions,
  fn: SpanBody<T>,
): Promise<T>;
export function startAsCurrentSpan<T>(options: SpanOptions, fn: SpanBody<T>): Promise<T>;
export function startAsCurrentSpan<T>(fn: SpanBody<T>): Promise<T>;
export function startAsCurrentSpan<T>(
  first: string | SpanOptions | SpanBody<T>,
  second?: SpanOptions | SpanBody<T>,
  third?: SpanBody<T>,
): Promise<T> {
  const { name, options, fn } = splitScopedArgs<SpanOptions, SpanBody<T>>(first, second, third);
  const attributes = creationAttributes(name, options);

  const run = () =>
    runActive(
      resolveName(name, options.kind, attributes),
      attributes,
      options.userId,
      (span) => configure(new Observation(span), options),
      fn,
      options.otelKind ?? otelSpanKind(options.kind ?? SpanKind.CHAIN),
    );

  // An AGENT span here establishes the scope that TOOL spans beneath it read
  // as `gen_ai.agent.name` — the agent EXECUTING the tool. The name is taken
  // from the attribute map rather than resolved a second time, the same way
  // `resolveName` reads it, so the scope and the span can never disagree
  // about which agent this is.
  //
  // Only this surface sets it, because only this surface activates a context.
  // `startSpan` returns a handle without making its span current, so there is
  // no scope for it to open and no place to close one; a TOOL span opened
  // "inside" a manual AGENT span therefore falls back to the configured name.
  // Callers who want the scope use the scoped helper or `observe`, which is
  // built on it.
  const scopeName =
    (options.kind ?? SpanKind.CHAIN) === SpanKind.AGENT ? attributes[GEN_AI_AGENT_NAME] : undefined;
  // An AGENT span with no resolvable name (nothing passed, nothing
  // configured) opens no scope: it has nothing to say, and an outer named
  // agent remains the truer answer for the tools below it.
  return typeof scopeName === "string" ? withAgentScope(scopeName, run) : run();
}

/**
 * The one scoped-span runner, shared with the generation helpers: start the
 * span active with `attributes`, hand `makeHandle(span)` to `fn`, record a
 * throw as an exception and rethrow, always end. `userId` is sugar for
 * `withUser` around the whole thing, so children opened inside inherit it
 * through UserSpanProcessor while this span gets it at creation.
 *
 * @internal Not re-exported from the package entry point.
 */
export function runActive<H extends Observation, T>(
  name: string,
  // Any OTel value: a generation's request parameters are set at creation,
  // and they are numbers, booleans and string arrays as often as strings.
  attributes: Attributes,
  userId: string | undefined,
  makeHandle: (span: Span) => H,
  fn: (handle: H) => Promise<T> | T,
  otelKind?: OtelSpanKind,
): Promise<T> {
  const run = () =>
    getTracer().startActiveSpan(name, { kind: otelKind, attributes }, async (span) => {
      const handle = makeHandle(span);
      try {
        return await fn(handle);
      } catch (error) {
        handle.recordException(error);
        throw error;
      } finally {
        handle.end();
      }
    });
  return userId !== undefined ? withUser(userId, run) : run();
}
