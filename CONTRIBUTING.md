# Contributing

Thanks for your interest in the Rius TypeScript SDK (`@glassflow-ai/rius` on
npm). This guide covers how to set up, test and submit a change.

To report a security problem, follow [SECURITY.md](SECURITY.md) instead of
opening an issue.

## Development setup

The SDK supports Node.js 18 and newer, and uses npm.

```bash
npm ci
```

Commit `package-lock.json` whenever dependencies change. [Biome](https://biomejs.dev/)
is the only linter and formatter: do not add ESLint or Prettier.

## Checks

All of these must pass before you open a pull request, and CI runs them on
every pull request (tests and packaging on Node 18, 20, 22 and 24):

```bash
npm run lint       # biome check (npm run format to fix)
npm run typecheck  # tsc --noEmit
npm run build      # tsup
npm test           # vitest run
```

## Code conventions

- TypeScript strict; no `any` without a reason written next to it.
- Public API is re-exported from `src/index.ts`.
- Prefer dependency injection over mocking (for example pass an exporter to
  `init` instead of patching the OTLP exporter).
- Attribute keys come from `src/semconv.ts`. The generated module
  `src/semconv.generated.ts` is vendored from
  [rius-semconv](https://github.com/glassflow/rius-semconv); never edit it by
  hand. Change the registry there, then re-pin with
  `TAG=<tag> scripts/sync-semconv.sh`.

## Tests first

We work test-first: write a failing test, watch it fail for the right reason,
then write the minimal code that makes it pass. Every behaviour change or bug
fix should come with a test that would have caught it.

## Pull requests

- Branch from `main`.
- Pull requests are squash-merged, and the PR title becomes the commit message
  on `main`. [release-please](https://github.com/googleapis/release-please)
  reads it to decide the next version, so the title must be a
  [Conventional Commit](https://www.conventionalcommits.org/):
  - `feat:` for a new feature (minor release)
  - `fix:` for a bug fix (patch release)
  - `feat!:` (or `fix!:`) for a breaking change; mark it in the title, since a
    `BREAKING CHANGE:` footer in a branch commit does not survive the squash
  - `docs:`, `test:`, `refactor:`, `chore:`, `ci:` for changes that do not
    release on their own
- Do not edit the version or `CHANGELOG.md`; release-please maintains both.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
