// Extracts NAME = "value" string constants from the Python SDK's semconv
// modules so a test can assert our values match verbatim. Reads from local
// paths or URLs, writes tests/fixtures/semconv.json.
//
// The Python SDK keeps its constants in _semconv_generated.py, vendored from
// rius-semconv, and its hand-written semconv.py re-exports them, so both are
// read. A source that does not exist is skipped (a Python SDK from before the
// vendored module has only semconv.py); parsing zero constants overall fails.
// SEMCONV_SOURCE overrides the sources: comma-separated paths or URLs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const PYTHON = "https://raw.githubusercontent.com/glassflow/rius-sdk-python/main/src/rius";
const SOURCES = process.env.SEMCONV_SOURCE
  ? process.env.SEMCONV_SOURCE.split(",")
  : [`${PYTHON}/_semconv_generated.py`, `${PYTHON}/semconv.py`];

// Send the token when the source URL requires authentication.
// raw.githubusercontent.com honors a GitHub token in the Authorization header.
const token = process.env.SEMCONV_SOURCE_TOKEN;

async function read(source) {
  if (!source.startsWith("http")) return existsSync(source) ? readFileSync(source, "utf8") : null;
  const r = await fetch(source, { headers: token ? { Authorization: `token ${token}` } : {} });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`fetch failed: ${r.status} ${source}`);
  return r.text();
}

const out = {};
for (const source of SOURCES) {
  const text = await read(source);
  if (text === null) {
    console.log(`skipped ${source}: not found`);
    continue;
  }
  for (const m of text.matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"$/gm)) {
    out[m[1]] = m[2];
  }
}
if (Object.keys(out).length === 0) throw new Error("parsed zero constants");

writeFileSync(
  new URL("../tests/fixtures/semconv.json", import.meta.url),
  `${JSON.stringify(out, null, 2)}\n`,
);
console.log(`wrote ${Object.keys(out).length} constants`);
