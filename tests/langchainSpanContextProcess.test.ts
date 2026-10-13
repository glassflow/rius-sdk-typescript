import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A model called from a callback running on LangChain's callback queue, in a
// short-lived process: a script that ends with `await awaitAllCallbacks()`.
// The inner call waits for its pending span; the wait's timer is the only
// thing that moves it forward, and nothing else keeps the event loop alive,
// because the inner call has not reached its provider yet. If the timer does
// not hold the process, Node exits with code 13 ("unsettled top-level await")
// before the inner call runs.
//
// vitest keeps its own process alive, so this runs the SDK in a fresh `node`,
// the way a script or CLI would: built from src/ for this run, then imported
// by a plain ESM script with the packages it needs resolved from the repo.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCRIPT = `
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { init } from "./index.mjs";

const client = init({ spanExporter: new InMemorySpanExporter(), heartbeat: false });
const enabled = await client.ready;
if (!enabled.includes("langchain")) {
  throw new Error("langchain did not load: " + JSON.stringify(enabled));
}

// No provider client: nothing but the wait's timer can hold the process.
class Echo extends BaseChatModel {
  _llmType() {
    return "echo";
  }
  async _generate() {
    return { generations: [{ text: "ok", message: new AIMessage("ok") }] };
  }
}

const chat = new Echo({});
let inner;
let once = false;
const evaluator = BaseCallbackHandler.fromMethods({
  async handleLLMEnd() {
    if (once) return;
    once = true;
    inner = (await chat.invoke("Was that right?")).content;
  },
});
await chat.invoke("Capital of France?", { callbacks: [evaluator] });
await awaitAllCallbacks();
console.log(JSON.stringify({ inner }));
`;

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
// @langchain/core 1.x needs Node 20 (it reads the global crypto Node 18 lacks).
const describeLangChain = nodeMajor >= 20 ? describe : describe.skip;

describeLangChain("LangChain in a short-lived process", () => {
  let dir: string;

  beforeAll(async () => {
    // Under the repo's node_modules, so the script's bare imports resolve.
    const cache = path.join(root, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    dir = await mkdtemp(path.join(cache, "rius-langchain-process-"));
    await build({
      config: false,
      entry: { index: path.join(root, "src", "index.ts") },
      format: ["esm"],
      outDir: dir,
      outExtension: () => ({ js: ".mjs" }),
      target: "node18",
      platform: "node",
      external: ["@opentelemetry/api"],
      shims: true,
      dts: false,
      silent: true,
    });
    await writeFile(path.join(dir, "check.mjs"), SCRIPT);
  }, 60_000);

  afterAll(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it("a model call made inside a running callback runs before the process exits", () => {
    const run = spawnSync(process.execPath, [path.join(dir, "check.mjs")], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, RIUS_HEARTBEAT: "false" },
    });
    // 13: the process exited with the inner call still waiting.
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}")).toEqual({ inner: "ok" });
  }, 60_000);
});
