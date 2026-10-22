import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { init, type RiusClient } from "../src/client.js";
import { contextSizes, textContents } from "../src/contextSizes.js";
import { startGeneration } from "../src/generation.js";
import { recordSplits, splitMedia, type TextSplit } from "../src/mediaParts.js";
import { normalizeMessages } from "../src/messages.js";
import { toAttributeValue } from "../src/serde.js";

const PNG = "data:image/png;base64,QUFB";
const prose = `see ${PNG} and (${PNG}) after`;

function record(msgs: ReturnType<typeof messagesOf>): Map<string, TextSplit | undefined> {
  const splits = new Map<string, TextSplit | undefined>(
    textContents(msgs).map((content) => [content, undefined]),
  );
  recordSplits(splits, () => toAttributeValue(msgs));
  return splits;
}

function messagesOf(...contents: string[]) {
  return [{ role: "user", parts: contents.map((content) => ({ type: "text", content })) }];
}

describe("the splits recorded while serializing", () => {
  it("are the split splitMedia returns for a text stripped by rule (b)", () => {
    const splits = record(messagesOf(prose));
    expect(splits.get(prose)).toEqual(splitMedia(prose));
    expect(splits.get(prose)?.tokens).toHaveLength(2);
  });

  it("are left unset for a JSON candidate, which the strip reads with a walk", () => {
    const candidate = JSON.stringify({ note: prose, items: [prose] });
    expect(record(messagesOf(candidate)).get(candidate)).toBeUndefined();
  });

  it("are left unset for a candidate too deep to parse inside the messages", () => {
    // Split alone it parses and its mime is image/png; inside the messages
    // rule (b) reads its raw text, `image\/png` and all.
    const content = `${"[".repeat(62)}"data:image\\/png;base64,AAAA"${"]".repeat(62)}`;
    expect(record(messagesOf(content)).get(content)).toBeUndefined();
    expect(splitMedia(content).tokens).toEqual([{ rule: "b", mime: "image/png", byteSize: 3 }]);
  });

  it("give the sizes the reused splits would compute from scratch", () => {
    const msgs = messagesOf(prose, "plain text", JSON.stringify({ a: prose }));
    const splits = record(msgs);
    expect(contextSizes(undefined, msgs, undefined, (t) => splits.get(t))).toBe(
      contextSizes(undefined, msgs, undefined),
    );
  });
});

describe("rius.context.sizes on a generation", () => {
  let client: RiusClient | undefined;
  afterEach(async () => {
    await client?.shutdown();
    client = undefined;
  });

  it("is what contextSizes computes without the reused splits", async () => {
    const exporter = new InMemorySpanExporter();
    client = init({ spanExporter: exporter, heartbeatTransport: async () => {} });
    const input = [
      { role: "user", content: [{ type: "text", text: prose }] },
      { role: "user", content: [{ type: "text", text: JSON.stringify({ a: prose }) }] },
    ];
    const generation = startGeneration("chat", { model: "m", input });
    generation.setOutput(prose);
    generation.end();
    await client.flush();
    const [span] = exporter.getFinishedSpans();
    expect(span.attributes["rius.context.sizes"]).toBe(
      contextSizes(
        undefined,
        normalizeMessages(input, "user"),
        normalizeMessages(prose, "assistant"),
      ),
    );
  });
});
