import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import { ExportOutcomeExporter } from "../src/exportHealth.js";

class StubExporter implements SpanExporter {
  constructor(private readonly code: ExportResultCode) {}
  export(_spans: ReadableSpan[], cb: (result: ExportResult) => void): void {
    cb({
      code: this.code,
      error: this.code === ExportResultCode.FAILED ? new Error("boom") : undefined,
    });
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

class ScriptedExporter implements SpanExporter {
  private index = 0;
  constructor(private readonly codes: ExportResultCode[]) {}
  export(_spans: ReadableSpan[], cb: (result: ExportResult) => void): void {
    const code = this.codes[this.index] ?? ExportResultCode.SUCCESS;
    this.index += 1;
    cb({ code, error: code === ExportResultCode.FAILED ? new Error("boom") : undefined });
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

describe("ExportOutcomeExporter", () => {
  it("starts healthy", () => {
    expect(
      new ExportOutcomeExporter(new StubExporter(ExportResultCode.SUCCESS)).lastExportFailed,
    ).toBe(false);
  });

  it("records failure and warns once, not per batch", () => {
    const warn = vi.fn();
    const exporter = new ExportOutcomeExporter(new StubExporter(ExportResultCode.FAILED), warn);
    exporter.export([], () => {});
    exporter.export([], () => {});
    expect(exporter.lastExportFailed).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("clears the flag once an export succeeds", () => {
    const exporter = new ExportOutcomeExporter(new StubExporter(ExportResultCode.SUCCESS));
    exporter.export([], () => {});
    expect(exporter.lastExportFailed).toBe(false);
  });

  it("passes the inner result through to the caller unchanged", () => {
    const exporter = new ExportOutcomeExporter(new StubExporter(ExportResultCode.FAILED));
    const cb = vi.fn();
    exporter.export([], cb);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ code: ExportResultCode.FAILED }));
  });

  it("does not re-arm the warning after a failure, a success, and another failure", () => {
    const warn = vi.fn();
    const exporter = new ExportOutcomeExporter(
      new ScriptedExporter([
        ExportResultCode.FAILED,
        ExportResultCode.SUCCESS,
        ExportResultCode.FAILED,
      ]),
      warn,
    );
    exporter.export([], () => {});
    exporter.export([], () => {});
    exporter.export([], () => {});
    expect(exporter.lastExportFailed).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
