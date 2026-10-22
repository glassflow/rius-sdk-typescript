import type { AttributeValue, Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  kindForOperation,
  OPENINFERENCE_SPAN_KIND,
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
 * every `gen_ai.*` key except the provider name, so it exports as a plain
 * CLIENT call. The backend classes a span as an LLM call by its kind, its
 * operation or its model, and prices it from its model and usage, so all of
 * those have to go. The SDK's other spans (the tool runner's `execute_tool`
 * and `invoke_agent`) have no OpenInference counterpart and pass untouched, as
 * does everything when the instrumentation is not enabled.
 */

/** The instrumentation scope prefix of the Anthropic SDK's own spans. */
const ANTHROPIC_SDK_SCOPE_PREFIX = "com.anthropic.sdk.";

/** The GenAI conventions' namespace, stripped from a demoted span. */
const GEN_AI_NAMESPACE = "gen_ai.";

type Bag = Record<string, AttributeValue | undefined>;

/** Remove the LLM classification, model, usage and content keys, in place. */
function demote(attributes: Bag): void {
  for (const key of Object.keys(attributes)) {
    if (key === GEN_AI_PROVIDER_NAME) continue;
    if (key === OPENINFERENCE_SPAN_KIND || key.startsWith(GEN_AI_NAMESPACE)) {
      delete attributes[key];
    }
  }
}

/**
 * Demotes the Anthropic SDK's chat spans while {@link enable}d. Must run ahead
 * of normalization at both hooks, so nothing downstream (the kind derived
 * from the operation, the pending snapshot) sees the span as an LLM call.
 */
export class NativeProviderSpanDemoter implements SpanProcessor {
  private enabled = false;
  private readonly demoted = new WeakSet<object>();

  /** Called once the OpenInference Anthropic instrumentation is registered. */
  enable(): void {
    this.enabled = true;
  }

  onStart(span: Span, _parentContext: Context): void {
    if (!this.enabled) return;
    try {
      const scope = span.instrumentationScope?.name;
      const operation = span.attributes[GEN_AI_OPERATION_NAME];
      if (
        typeof scope !== "string" ||
        !scope.startsWith(ANTHROPIC_SDK_SCOPE_PREFIX) ||
        typeof operation !== "string" ||
        kindForOperation(operation) !== SpanKind.LLM
      ) {
        return;
      }
      this.demoted.add(span);
      // A live span's bag is writable by reference, as normalization's is.
      demote(span.attributes as Bag);
    } catch {
      // An exotic span must not break span creation; it keeps its keys.
    }
  }

  onEnd(span: ReadableSpan): void {
    if (!this.demoted.has(span)) return;
    try {
      // Again: usage, the response model and content arrive during the call.
      demote(span.attributes as Bag);
    } catch {
      // As above.
    }
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
