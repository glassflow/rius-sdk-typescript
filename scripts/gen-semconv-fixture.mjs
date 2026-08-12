// Extracts NAME = "value" string constants from the Python SDK's semconv.py so
// a test can assert our values match verbatim. Reads from a local clone path or
// a URL, writes tests/fixtures/semconv.json.
import { writeFileSync } from "node:fs";

const SOURCE =
  process.env.SEMCONV_SOURCE ??
  "https://raw.githubusercontent.com/glassflow/rius-sdk-python/main/src/rius/semconv.py";

// rius-sdk-python is a private repo, so the default raw-GitHub URL 404s
// unauthenticated. When a token is available, send it; raw.githubusercontent.com
// honors a GitHub token in the Authorization header for private-repo content.
const token = process.env.SEMCONV_SOURCE_TOKEN;
const text = SOURCE.startsWith("http")
  ? await fetch(SOURCE, {
      headers: token ? { Authorization: `token ${token}` } : {},
    }).then((r) => {
      if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
      return r.text();
    })
  : (await import("node:fs")).readFileSync(SOURCE, "utf8");

const out = {};
for (const m of text.matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"$/gm)) {
  out[m[1]] = m[2];
}
if (Object.keys(out).length === 0) throw new Error("parsed zero constants");

writeFileSync(
  new URL("../tests/fixtures/semconv.json", import.meta.url),
  `${JSON.stringify(out, null, 2)}\n`,
);
console.log(`wrote ${Object.keys(out).length} constants`);
