import type { AttributeValue, Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  OPENINFERENCE_SPAN_KIND,
  operationForKind,
  SpanKind,
} from "./semconv.js";

/**
 * Keeps one LLM span per Anthropic call when the provider SDK traces itself.
 *
 * From 0.134, `@anthropic-ai/sdk` starts a span of its own for every API call
 * once a global tracer provider is registered, which Rius does. Its chat span
 * for `messages.create` records the same call as the OpenInference Anthropic
 * instrumentation's LLM span: as that span's child, or, for `messages.stream()`,
 * as its sibling. Two LLM spans per call would count the call, and its cost,
 * twice.
 *
 * While Rius has the OpenInference instrumentation enabled, the SDK's chat
 * span is demoted instead of dropped: it keeps its place in the trace, and the
 * HTTP spans an application's own instrumentation hangs under it, but loses
 * every `gen_ai.*` key except the provider name and the conversation id, so
 * it exports as a plain CLIENT call. The backend classes a span as an LLM call by its kind, its
 * operation or its model, and prices it from its model and usage, so all of
 * those have to go. The SDK's other spans (the tool runner's `execute_tool`
 * and `invoke_agent`) have no OpenInference counterpart and pass untouched, as
 * does everything when the instrumentation is not enabled.
 */

/** The instrumentation scope prefix of the Anthropic SDK's own spans. */
const ANTHROPIC_SDK_SCOPE_PREFIX = "com.anthropic.sdk.";

/** The GenAI conventions' namespace, stripped from a demoted span. */
const GEN_AI_NAMESPACE = "gen_ai.";

/**
 * Kept on a demoted span, with the provider name: an id, not content, and
 * nothing the backend classes or prices by. Not a registry constant because
 * Rius never emits it (it emits session.id); this only leaves the Anthropic
 * SDK's own value in place, as the Python SDK does.
 */
const GEN_AI_CONVERSATION_ID = "gen_ai.conversation.id";

type Bag = Record<string, AttributeValue | undefined>;

/** Remove the LLM classification, model, usage and content keys, in place. */
function demote(attributes: Bag): void {
  for (const key of Object.keys(attributes)) {
    if (key === GEN_AI_PROVIDER_NAME || key === GEN_AI_CONVERSATION_ID) continue;
    if (key === OPENINFERENCE_SPAN_KIND || key.startsWith(GEN_AI_NAMESPACE)) {
      delete attributes[key];
    }
  }
}

/**
 * The operation of the Anthropic SDK's span for a Messages call. Only that
 * one: it is the only operation the SDK gives a span the instrumentation also
 * records, and the rule is the same in the Python SDK.
 */
const CHAT = operationForKind(SpanKind.LLM);

/** The Anthropic SDK's own span for a call the OpenInference instrumentation records. */
function isNativeChatSpan(
  span: Pick<ReadableSpan, "instrumentationScope" | "attributes">,
): boolean {
  const scope = span.instrumentationScope?.name;
  return (
    typeof scope === "string" &&
    scope.startsWith(ANTHROPIC_SDK_SCOPE_PREFIX) &&
    CHAT !== undefined &&
    span.attributes[GEN_AI_OPERATION_NAME] === CHAT
  );
}

/**
 * Demotes the Anthropic SDK's chat spans while {@link enable}d. Must run ahead
 * of normalization at both hooks, so nothing downstream (the kind derived
 * from the operation, the pending snapshot) sees the span as an LLM call.
 */
export class NativeProviderSpanDemoter implements SpanProcessor {
  private enabled = false;
  /** Spans demoted at start, whose own operation is already gone at end. */
  private readonly demoted = new WeakSet<object>();

  /**
   * Called when the OpenInference Anthropic instrumentation is registered on
   * this client's provider, and {@link disable}d when that registration is
   * undone (shutdown() runs both teardowns together), so the demoter follows
   * whether the instrumentation is bound right now.
   */
  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  onStart(span: Span, _parentContext: Context): void {
    if (!this.enabled) return;
    try {
      if (!isNativeChatSpan(span)) return;
      this.demoted.add(span);
      // A live span's bag is writable by reference, as normalization's is.
      demote(span.attributes as Bag);
    } catch {
      // An exotic span must not break span creation; it keeps its keys.
    }
  }

  /**
   * Decided again from the span itself, not only from what onStart saw: a
   * span bridged from another provider (bridgeForeignProvider) reaches the
   * pipeline at start and at end as two different copies, and the copy at end
   * carries every key the other SDK set, the operation included. That bag is
   * the copy, so the other provider's span is never touched.
   */
  onEnd(span: ReadableSpan): void {
    try {
      if (!this.demoted.has(span) && !(this.enabled && isNativeChatSpan(span))) return;
      // Again: usage, the response model and content arrive during the call.
      demote(span.attributes as Bag);
    } catch {
      // As above.
    }
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
