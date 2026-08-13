import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

/**
 * BatchSpanProcessor discards export results, so a wrong key or endpoint is
 * otherwise invisible. Warn once, loudly, and expose the outcome so flush()
 * can report delivery honestly rather than only "queue drained".
 *
 * Never throws into the export pipeline.
 */
export class ExportOutcomeExporter implements SpanExporter {
  private failed = false;
  private warned = false;

  constructor(
    private readonly inner: SpanExporter,
    private readonly onFirstFailure: (message: string) => void = (m) => console.warn(m),
  ) {}

  get lastExportFailed(): boolean {
    return this.failed;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.inner.export(spans, (result) => {
      if (result.code === ExportResultCode.FAILED) {
        this.failed = true;
        if (!this.warned) {
          this.warned = true;
          try {
            this.onFirstFailure(
              `[rius] span export failed: ${result.error?.message ?? "unknown error"}. Check RIUS_API_KEY and RIUS_ENDPOINT. Further failures will not be logged.`,
            );
          } catch {
            // a failing logger must not break export
          }
        }
      } else {
        this.failed = false;
      }
      resultCallback(result);
    });
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
