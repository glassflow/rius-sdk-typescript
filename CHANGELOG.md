# Changelog

## [0.3.1](https://github.com/glassflow/rius-sdk-typescript/compare/v0.3.0...v0.3.1) (2026-08-27)


### Bug Fixes

* instrument both builds of a dual-package provider SDK ([#26](https://github.com/glassflow/rius-sdk-typescript/issues/26)) ([c9edda4](https://github.com/glassflow/rius-sdk-typescript/commit/c9edda4f168783bd787ee61be5ffd3039c56e58e))

## [0.3.0](https://github.com/glassflow/rius-sdk-typescript/compare/v0.2.4...v0.3.0) (2026-08-20)


### Features

* session ids — a scoped withSession() plus an init-level default ([#22](https://github.com/glassflow/rius-sdk-typescript/issues/22)) ([205c03d](https://github.com/glassflow/rius-sdk-typescript/commit/205c03d836a69e7bed3d7029db9feb4773b16e8a))
* stamp service.instance.id on spans and share it with the heartbeat ([#24](https://github.com/glassflow/rius-sdk-typescript/issues/24)) ([a523813](https://github.com/glassflow/rius-sdk-typescript/commit/a523813ddb2a977efa0f27009c3c08dc9af0ce15))

## [0.2.4](https://github.com/glassflow/rius-sdk-typescript/compare/v0.2.3...v0.2.4) (2026-08-17)


### Bug Fixes

* export OTLP protobuf, which the ingest requires, instead of JSON ([#20](https://github.com/glassflow/rius-sdk-typescript/issues/20)) ([c018bac](https://github.com/glassflow/rius-sdk-typescript/commit/c018bac11b6140fd0579b77760a89760ea3a2c77))

## [0.2.3](https://github.com/glassflow/rius-sdk-typescript/compare/v0.2.2...v0.2.3) (2026-08-17)


### Bug Fixes

* match the Python SDK's MCP span name and error-result status ([#17](https://github.com/glassflow/rius-sdk-typescript/issues/17)) ([5251a09](https://github.com/glassflow/rius-sdk-typescript/commit/5251a099cbd9471da2d8cd8dbed61f2aa643dba6))

## [0.2.2](https://github.com/glassflow/rius-sdk-typescript/compare/v0.2.1...v0.2.2) (2026-08-14)


### Bug Fixes

* bump the exported VERSION with releases and assert it matches package.json ([#15](https://github.com/glassflow/rius-sdk-typescript/issues/15)) ([6436e61](https://github.com/glassflow/rius-sdk-typescript/commit/6436e61cb4f3adfc095cc25c8b294c6564c72e36))

## [0.2.1](https://github.com/glassflow/rius-sdk-typescript/compare/v0.2.0...v0.2.1) (2026-08-14)


### Bug Fixes

* add repository metadata required for npm provenance ([#12](https://github.com/glassflow/rius-sdk-typescript/issues/12)) ([ff58589](https://github.com/glassflow/rius-sdk-typescript/commit/ff5858926805d1f80210edca871bc9fd32e7b052))

## [0.2.0](https://github.com/glassflow/rius-sdk-typescript/compare/v0.1.0...v0.2.0) (2026-08-14)


### Features

* agent heartbeat and partial spans (RIUS-394) ([#10](https://github.com/glassflow/rius-sdk-typescript/issues/10)) ([819dd54](https://github.com/glassflow/rius-sdk-typescript/commit/819dd54fd92a11bffe514982f680836c405a2408))


### Bug Fixes

* document the undocumented public API surface ([3a24429](https://github.com/glassflow/rius-sdk-typescript/commit/3a24429ced09c2395075a22333cc8ee85e0f7035))

## [0.1.0](https://github.com/glassflow/rius-sdk-typescript/compare/v0.1.0...v0.1.0) (2026-08-14)


### Features

* add anthropic and langchain auto-instrumentation entries (RIUS-197) ([39fb741](https://github.com/glassflow/rius-sdk-typescript/commit/39fb7418e9313456aea53fe647d75ecc9e0dd90c))
* add gen_ai-native generation surfaces (RIUS-197) ([c92f3c7](https://github.com/glassflow/rius-sdk-typescript/commit/c92f3c72d8f504ca5c2b357c462da2636b3563fb))
* add init() with provider, sampler and exporter chain (RIUS-197) ([835adce](https://github.com/glassflow/rius-sdk-typescript/commit/835adce3e9891d29c26d38e34effbb496e4c503b))
* add lazy instrumentation registry with processor and instrumentation kinds (RIUS-197) ([d2b0897](https://github.com/glassflow/rius-sdk-typescript/commit/d2b089751da4f5bd7314d381aaf211fff4631123))
* add observe() wrapper for plain functions (RIUS-197) ([0bf8330](https://github.com/glassflow/rius-sdk-typescript/commit/0bf8330d2ca7389194e0ebc8f1fb4846491d2488))
* add safe attribute value serialization (RIUS-197) ([81c4da3](https://github.com/glassflow/rius-sdk-typescript/commit/81c4da33d1414f6353e3db48b3ea3473b606edc8))
* add semconv vocabulary with Python parity fixture (RIUS-197) ([ca3b949](https://github.com/glassflow/rius-sdk-typescript/commit/ca3b949ab230f78618a3b2434aea72d7c008e516))
* add span surfaces, scoped and manual (RIUS-197) ([281a96f](https://github.com/glassflow/rius-sdk-typescript/commit/281a96fc84aed39e62ca5a24ace9ff4160b24dc3))
* emit mcp.result_type for interim tools/call rounds (RIUS-197) ([c25e3af](https://github.com/glassflow/rius-sdk-typescript/commit/c25e3af96c87abed44693b7252ac13d606f6686c))
* export the public API and document it (RIUS-197) ([1cdd2fa](https://github.com/glassflow/rius-sdk-typescript/commit/1cdd2fa720bfa45726f1cd03cefb6f8168b0d37d))
* finish reasons, request parameters, optional options and recordException (RIUS-197) ([ba6f18f](https://github.com/glassflow/rius-sdk-typescript/commit/ba6f18f8539a28bb12b6ff37c33f2795ca625a72))
* mask or strip content attributes at export (RIUS-197) ([6910bf6](https://github.com/glassflow/rius-sdk-typescript/commit/6910bf69f335c59edba2c16aecf258e5f5cceb17))
* patch the provider build in use so pure-ESM apps get spans ([0c8e80d](https://github.com/glassflow/rius-sdk-typescript/commit/0c8e80d50b1ae80b5dbbdf151aeae24e5fb0b5f0))
* patch the provider build in use so pure-ESM apps get spans (RIUS-381) ([02dae2a](https://github.com/glassflow/rius-sdk-typescript/commit/02dae2aa91af3fbc2e6aff0368aa3ad2c1d2a27e))
* resolve config from options then RIUS_ env vars (RIUS-197) ([d452193](https://github.com/glassflow/rius-sdk-typescript/commit/d45219323bde9edc4a111fec4ea1ca1075838837))
* surface export failures instead of swallowing them (RIUS-197) ([3c5a1d9](https://github.com/glassflow/rius-sdk-typescript/commit/3c5a1d9f13dcedf4f995685b1ba50232dc0ad573))
* trace MCP client tool calls (RIUS-197) ([c8374b0](https://github.com/glassflow/rius-sdk-typescript/commit/c8374b0a8cc8886cc55a7d6c99717213ad467537))
* TypeScript SDK v1 (RIUS-197) ([1000c1e](https://github.com/glassflow/rius-sdk-typescript/commit/1000c1e19db49a28610db22f8b743a49cc96be17))


### Bug Fixes

* apply content masking to span event and link attributes (RIUS-197) ([c49ff15](https://github.com/glassflow/rius-sdk-typescript/commit/c49ff1574241948e792425c36554256841615ee0))
* classify absent optional peers by package, not full subpath specifier (RIUS-197) ([105ce4a](https://github.com/glassflow/rius-sdk-typescript/commit/105ce4a61a2a9da9ae125ef082c391db323862e6))
* correct package license to MIT and add LICENSE file ([450c729](https://github.com/glassflow/rius-sdk-typescript/commit/450c7296979e33d517a1686374875d2fcdb96527))
* exclude dist and other generated dirs from biome lint (RIUS-197) ([5d249c8](https://github.com/glassflow/rius-sdk-typescript/commit/5d249c803aefdc13bbe3dd7a3142f4293901cd18))
* fall back to default on unrecognized boolean env var, add tests (RIUS-197) ([81af3be](https://github.com/glassflow/rius-sdk-typescript/commit/81af3be8279dcb2c738e560ff1442abc536996d5))
* make Generation.recordFirstToken idempotent (RIUS-197) ([6f6996b](https://github.com/glassflow/rius-sdk-typescript/commit/6f6996bc1eef4e4e5f9a855f5f1cdc0e7ce5aa6b))
* make init() the sole client factory and honour disabled fully (RIUS-197) ([debb760](https://github.com/glassflow/rius-sdk-typescript/commit/debb7601dee660ee150bbe6cebff497461509f85))
* make Node 18 CI legs pass ([4957306](https://github.com/glassflow/rius-sdk-typescript/commit/4957306bf92c06e0b9a4059c5696eb562df25318))
* nest types per export condition and use biome vcs ignore (RIUS-197) ([3161979](https://github.com/glassflow/rius-sdk-typescript/commit/3161979e9e62885d20f4b3a4e5fc8ca8cf18c245))
* patch the CJS MCP Client build too, and prove all entries function from packed consumers ([a3fd0a4](https://github.com/glassflow/rius-sdk-typescript/commit/a3fd0a48efb9f9ad456796a9cd795ca925d45a28))
* patch the CJS MCP Client build too, and prove all entries function from packed consumers ([ece0e46](https://github.com/glassflow/rius-sdk-typescript/commit/ece0e460f7d1b8d3371acaafcf4b81f47ceb1922))
* scrub span status.message under captureContent: false (RIUS-197) ([edd9cf3](https://github.com/glassflow/rius-sdk-typescript/commit/edd9cf316c37e2d187d0afc4e39a86271b923f76))
* track ancestor chain for cycle detection instead of global seen-set (RIUS-197) ([54b252b](https://github.com/glassflow/rius-sdk-typescript/commit/54b252bb52c3096d07136de367b35354ef5e2b12))
* transform Vercel AI spans in place ahead of export, and stop laundering load failures (RIUS-197) ([32cd2e4](https://github.com/glassflow/rius-sdk-typescript/commit/32cd2e4c5ec9b88df66bb375bfe48db995f0e5f3))
* treat unflattened llm.prompts/llm.prompt_template as content (RIUS-197) ([2be5fa8](https://github.com/glassflow/rius-sdk-typescript/commit/2be5fa871237a6edd92d1879f9404203544d64ab))
* warn when a provider loads with an unrecognised shape ([e7f198d](https://github.com/glassflow/rius-sdk-typescript/commit/e7f198d6390eec9910be4cd918883eeab436c898))
* warn when an optional integration fails after import instead of skipping silently (RIUS-197) ([f9bfd1c](https://github.com/glassflow/rius-sdk-typescript/commit/f9bfd1c486eeb46d37611418a7f7a49ff319623b))


### Miscellaneous Chores

* release 0.1.0 ([305d952](https://github.com/glassflow/rius-sdk-typescript/commit/305d9525436dc5bb656ed6533b70b7942f524742))
