# CLAUDE.md — rius-sdk-typescript

Conventions for the GlassFlow instrumentation SDK (TypeScript). Follow these;
they override generic defaults. The Python SDK (`rius-sdk-python`) is the
reference implementation this SDK keeps parity with.

## What this is

A public, OpenTelemetry-native tracing SDK for AI agents / LLM applications. It
emits **OpenTelemetry GenAI (`gen_ai.*`) traces over OTLP/HTTP** to the managed
GlassFlow platform (or any OTLP-compatible backend). GlassFlow is
**managed-only** — there is no self-host, so config targets the managed endpoint.

- Package: `@glassflow-ai/rius` (npm), ESM-first with a CJS build (`dist/`)
- Node `>=18`; CI tests Node 18, 20, 22 and 24
- `src/` for the library, `tests/` for vitest suites, `scripts/` for fixture generators

## Tooling (npm)

```bash
npm ci                 # set up the environment (commit package-lock.json)
npm run lint           # biome check .
npm run format         # biome check --write .
npm run typecheck      # tsc --noEmit
npm run build          # tsup
npm test               # vitest run
```

Biome is the only linter/formatter. Do not add ESLint or Prettier.

## Code conventions

- TypeScript strict; no `any` without a reason written next to it.
- Public API is re-exported from `src/index.ts`.
- Prefer **dependency injection over mocking** for testability
  (e.g. pass an exporter to `init` instead of patching the OTLP exporter).
- Treat caller-supplied objects as untrusted when using them as lookup tables:
  use `Object.hasOwn`, so keys like `__proto__` or `constructor` never match
  through the prototype chain.

## OpenTelemetry conventions

- **Convention-native** wire format — emit established conventions directly,
  never a bespoke `glassflow.*` namespace. Every span carries BOTH
  `openinference.span.kind` and `gen_ai.operation.name` where the kind maps.
- LLM/generation spans are fully `gen_ai`-native; generic/tool/retriever spans
  use `input.value` / `output.value`.
- **Span API naming:** `startAsCurrent*` activates context and ends the span
  for you; bare `start*` returns a handle you must `.end()`. Don't invert these.
- **All attribute keys live in `src/semconv.ts`.** No string literals for
  attribute or event names elsewhere.
- **Normalization** (`src/normalize.ts`) rewrites third-party dialects in place
  at `onEnd`. Because it mutates in place, an expanding rule that returns its own
  source key is a correctness requirement, not a nicety. Native canonical keys
  always win; normalization only fills gaps. It runs BEFORE masking, so masking
  only ever sees canonical keys.

## Parity with the Python SDK

- `tests/fixtures/semconv.json` mirrors the string constants in Python's
  `semconv.py`, and `tests/semconv.test.ts` requires every one of them to exist
  here with the same value, or be listed in `PYTHON_ONLY` with the reason.
- Regenerate it from Python's `main`:
  `SEMCONV_SOURCE=<path to semconv.py> node scripts/gen-semconv-fixture.mjs`.
  The `semconv-parity` workflow does this on a schedule and on semconv changes.
  It **skips silently** when `SEMCONV_SOURCE_TOKEN` is unset, so check its log,
  not just its green check.
- When porting a Python change, port its rule order, member lists and type
  guards too, and say in the PR where a language difference forces a divergence.

## Testing — TDD (required)

- **Test-first.** Write a failing test, watch it fail for the right reason, then
  write minimal code to pass.
- Mutation-check new rules: break the code, confirm a test fails, restore it,
  and say so in the PR.
- Before pushing, gate on the exit codes of `lint`, `typecheck`, `build` and
  `test`, not on grepping their output.

## Versioning & releases

- The version lives in `src/index.ts` (`VERSION`, annotated
  `// x-release-please-version`) and `package.json`. **Do not** edit it by hand or
  hand-write `CHANGELOG.md`.
- Releases are automated by **release-please**: merging its Release PR bumps the
  version, tags, and publishes.

## Git & PR conventions

- **Branch from `main`.** Branch names: `<user>/<TICKET>-short-desc`
  (e.g. `pablo/rius-1007-finish-reason`). Linear links only the FIRST ticket ID
  in a branch name; name others with `Closes RIUS-xxx` in the PR body.
- **PRs are squash-merged; the PR title becomes the commit on `main`** and is
  what release-please reads. Titles must be Conventional Commits: `feat:`,
  `fix:`, `feat!:` (breaking — mark it in the **title**), plus
  `chore:`/`docs:`/`test:`/`refactor:`/`ci:`. A behaviour change titled `test:`
  or `refactor:` produces no release.
- **No ticket IDs in code** comments or docs; write the reason instead. Ticket
  IDs belong in branch names, PR titles/bodies and commits.
- Never write "Part of RIUS-xxx" in a PR body: it overrides the branch link and
  stops Linear from moving the ticket on merge.
- **No AI attribution** in commits or PRs (no `Co-Authored-By: Claude`, no
  "Generated with…" trailers).
- CI (lint, typecheck, build, tests and packaging on Node 18–24) must pass to merge.
