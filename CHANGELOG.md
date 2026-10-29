# Changelog

## [1.8.3](https://github.com/glassflow/rius-sdk-typescript/compare/v1.8.2...v1.8.3) (2026-10-29)


### Bug Fixes

* **deps:** bump @arizeai/openinference-instrumentation-anthropic from 0.2.11 to 1.0.0 ([#224](https://github.com/glassflow/rius-sdk-typescript/issues/224)) ([1ad314f](https://github.com/glassflow/rius-sdk-typescript/commit/1ad314fcb98c13aacd5c60fa4ff39690adc13604))

## [1.8.2](https://github.com/glassflow/rius-sdk-typescript/compare/v1.8.1...v1.8.2) (2026-10-27)


### Bug Fixes

* keep the compacted flag when a span is at its event cap (RIUS-1578) ([#217](https://github.com/glassflow/rius-sdk-typescript/issues/217)) ([2a1f91d](https://github.com/glassflow/rius-sdk-typescript/commit/2a1f91df03bede28a4a6fa0d4543cfc827364413))
* warn when the endpoint sends traces over plain http (RIUS-1687) ([#219](https://github.com/glassflow/rius-sdk-typescript/issues/219)) ([355a67a](https://github.com/glassflow/rius-sdk-typescript/commit/355a67a8dd00ddd0e17132ae6123b54df158dc5b))

## [1.8.1](https://github.com/glassflow/rius-sdk-typescript/compare/v1.8.0...v1.8.1) (2026-10-27)


### Bug Fixes

* align Mistral provider name and zero usage counts with GenAI semconv ([#213](https://github.com/glassflow/rius-sdk-typescript/issues/213)) ([9616863](https://github.com/glassflow/rius-sdk-typescript/commit/961686311f2b6015a9cceded350c5b3045883c9f))
* drop zero usage breakdowns from third-party spans ([#215](https://github.com/glassflow/rius-sdk-typescript/issues/215)) ([4c095e7](https://github.com/glassflow/rius-sdk-typescript/commit/4c095e7a73a4a3e94a65fbb9c4d9fd73e91d84c6))
* re-pin rius-semconv to v1.10.0 ([#216](https://github.com/glassflow/rius-sdk-typescript/issues/216)) ([fdea6e8](https://github.com/glassflow/rius-sdk-typescript/commit/fdea6e8a03749d37c9c5a6488483f677ca904923))

## [1.8.0](https://github.com/glassflow/rius-sdk-typescript/compare/v1.7.0...v1.8.0) (2026-10-23)


### Features

* build a scoped client with init({ setGlobal: false }) ([#210](https://github.com/glassflow/rius-sdk-typescript/issues/210)) ([77dec3c](https://github.com/glassflow/rius-sdk-typescript/commit/77dec3c9f627d8c3415e11c837d163be2c360f0f))
* select bundled integrations with init({ instruments }) ([#209](https://github.com/glassflow/rius-sdk-typescript/issues/209)) ([d4e3888](https://github.com/glassflow/rius-sdk-typescript/commit/d4e38886d4dd043c4d00e464264d3c4c14b83874))
* send extra headers with init({ headers }) ([#212](https://github.com/glassflow/rius-sdk-typescript/issues/212)) ([4cccbb4](https://github.com/glassflow/rius-sdk-typescript/commit/4cccbb42f508f8ccea99e7622e3fe5396aae7aef))


### Bug Fixes

* drop the Anthropic SDK's tool output with captureContent off ([#205](https://github.com/glassflow/rius-sdk-typescript/issues/205)) ([1a260db](https://github.com/glassflow/rius-sdk-typescript/commit/1a260dbbc781322ebad69ac3bbdb83bff08884c5))
* drop the Anthropic SDK's URL query with captureContent off ([#211](https://github.com/glassflow/rius-sdk-typescript/issues/211)) ([8549a4a](https://github.com/glassflow/rius-sdk-typescript/commit/8549a4aff96ff28be5984c643ac953aa7152cc07))
* end the span of a generator abandoned mid-iteration when it is collected ([#208](https://github.com/glassflow/rius-sdk-typescript/issues/208)) ([3875754](https://github.com/glassflow/rius-sdk-typescript/commit/38757547a2b45a8259e28c4b0120b983a73bf1af))
* name the Anthropic SDK's native span errors by exception class ([#206](https://github.com/glassflow/rius-sdk-typescript/issues/206)) ([2a3a0cd](https://github.com/glassflow/rius-sdk-typescript/commit/2a3a0cdc1de3b1bd7a1e06fc5abb47c395ad3ba7))

## [1.7.0](https://github.com/glassflow/rius-sdk-typescript/compare/v1.6.0...v1.7.0) (2026-10-22)


### Features

* **observe:** trace generators over the whole iteration; serde, docs and API parity fixes ([#189](https://github.com/glassflow/rius-sdk-typescript/issues/189)) ([6e0ee88](https://github.com/glassflow/rius-sdk-typescript/commit/6e0ee88213ac14b7e28d2b28f76444432240191a))


### Bug Fixes

* always drop credential headers from spans, whatever captureContent is ([#188](https://github.com/glassflow/rius-sdk-typescript/issues/188)) ([60f9790](https://github.com/glassflow/rius-sdk-typescript/commit/60f979071a808d179911d58b4bd9e88dfdcb1b62))
* mask exception events, keep content off pending snapshots, strip more ai.* content keys ([#186](https://github.com/glassflow/rius-sdk-typescript/issues/186)) ([eb32bde](https://github.com/glassflow/rius-sdk-typescript/commit/eb32bde41aef89260f9ea3920958c64fc0584d5d))
* **anthropic:** demote the Anthropic SDK's own chat span; bump @anthropic-ai/sdk to 1.1.0 and openai to 7.42.0 ([#202](https://github.com/glassflow/rius-sdk-typescript/issues/202)) ([7341636](https://github.com/glassflow/rius-sdk-typescript/commit/73416362085a5325196c6b1821fedcc68298d25c))
* **sdk:** never break a foreign OTel SDK on shutdown or throw into host code ([#184](https://github.com/glassflow/rius-sdk-typescript/issues/184)) ([13c3a10](https://github.com/glassflow/rius-sdk-typescript/commit/13c3a10a624b92ffeb41fb9f5ac106bfa36a48c7))
* **sdk:** report the SDK's own version when bundled; fix serde, context and workspace leaks ([#183](https://github.com/glassflow/rius-sdk-typescript/issues/183)) ([86c22b1](https://github.com/glassflow/rius-sdk-typescript/commit/86c22b1b5abbcfdca2fb40a8ab3e356c8378176d))
* **spans:** setAttribute writes an array holding an array or an object as one JSON string; run the shared SDK cases and usage-key rows ([#190](https://github.com/glassflow/rius-sdk-typescript/issues/190)) ([70210c2](https://github.com/glassflow/rius-sdk-typescript/commit/70210c21d9aa5041be669def6ffad459a6d72654))
* **wire:** align value encoding, env parsing and resource attributes with the Python SDK ([#185](https://github.com/glassflow/rius-sdk-typescript/issues/185)) ([ecfca08](https://github.com/glassflow/rius-sdk-typescript/commit/ecfca08d09ceb2d86d0a235e928c24a5a5662fb2))

## [1.6.0](https://github.com/glassflow/rius-sdk-typescript/compare/v1.5.0...v1.6.0) (2026-10-22)


### Features

* report provider compactions and add markCompaction (RIUS-1545) ([#180](https://github.com/glassflow/rius-sdk-typescript/issues/180)) ([ba7842f](https://github.com/glassflow/rius-sdk-typescript/commit/ba7842f56b1442f0d7b9f7436f96a0a156e9cb1f))


### Bug Fixes

* strip percent-encoded and escaped-wrapped data URLs, and size a newline-terminated one ([#182](https://github.com/glassflow/rius-sdk-typescript/issues/182)) ([c048e3c](https://github.com/glassflow/rius-sdk-typescript/commit/c048e3c8ac106078dc5a85062738047f7a866c17))

## [1.5.0](https://github.com/glassflow/rius-sdk-typescript/compare/v1.4.1...v1.5.0) (2026-10-21)


### Features

* map pydantic-ai's Gemini image and audio token details onto the modality usage keys ([#176](https://github.com/glassflow/rius-sdk-typescript/issues/176)) ([93ab5e9](https://github.com/glassflow/rius-sdk-typescript/commit/93ab5e9a93a866890b763ef2b424219b5286c96d))
* media leaves the SDK as stripped semconv parts ([#168](https://github.com/glassflow/rius-sdk-typescript/issues/168)) ([38b3cb4](https://github.com/glassflow/rius-sdk-typescript/commit/38b3cb460a175135ccacc52f530217acdc04890c))


### Bug Fixes

* media contract round 3: byte objects, new strip rules, LangChain v1 reference blocks ([#173](https://github.com/glassflow/rius-sdk-typescript/issues/173)) ([d785d6d](https://github.com/glassflow/rius-sdk-typescript/commit/d785d6df523e6370bdc11ba417888ea23828c6ab))
* settle non-http URIs, empty or redacted references and the Vercel fallback ([#171](https://github.com/glassflow/rius-sdk-typescript/issues/171)) ([6dc8723](https://github.com/glassflow/rius-sdk-typescript/commit/6dc8723d499c33f6efeeb0e83a3b02404dc01dfc))
* strip a data URL once per span and size it without re-validating ([#175](https://github.com/glassflow/rius-sdk-typescript/issues/175)) ([8104ed4](https://github.com/glassflow/rius-sdk-typescript/commit/8104ed42a4a5417a908df90a668a127860783cfe))
* strip a data URL that follows a link or wraps across lines ([#177](https://github.com/glassflow/rius-sdk-typescript/issues/177)) ([56b020b](https://github.com/glassflow/rius-sdk-typescript/commit/56b020b89aea7acc8aa7f0ec5c2fe8b46b4e9b66))
* strip LangChain v1, Bedrock and Mistral audio base64 ([#170](https://github.com/glassflow/rius-sdk-typescript/issues/170)) ([ed3e77e](https://github.com/glassflow/rius-sdk-typescript/commit/ed3e77eadbf2e2a6e1ede62f86f0f03ac967ae63))

## [1.4.1](https://github.com/glassflow/rius-sdk-typescript/compare/v1.4.0...v1.4.1) (2026-10-16)


### Bug Fixes

* stop emitting mcp.result_type on interim MCP rounds ([#162](https://github.com/glassflow/rius-sdk-typescript/issues/162)) ([e557db0](https://github.com/glassflow/rius-sdk-typescript/commit/e557db09a49a86efd16115889963b9d82c6a6ed8))
* stop emitting the gen_ai.first_token event ([#164](https://github.com/glassflow/rius-sdk-typescript/issues/164)) ([8692dc8](https://github.com/glassflow/rius-sdk-typescript/commit/8692dc80ee99b0b5e1e578fd267fd721fb1553d2))

## [1.4.0](https://github.com/glassflow/rius-sdk-typescript/compare/v1.3.0...v1.4.0) (2026-10-15)


### Features

* classify @ai-sdk/otel's decide, speech and transcription spans as LLM ([#139](https://github.com/glassflow/rius-sdk-typescript/issues/139)) ([19acb40](https://github.com/glassflow/rius-sdk-typescript/commit/19acb405bbdc6e7245cf1f39bc72d0621453c715))


### Bug Fixes

* **deps:** move OpenTelemetry and the AI SDK in lockstep ([#152](https://github.com/glassflow/rius-sdk-typescript/issues/152)) ([4252363](https://github.com/glassflow/rius-sdk-typescript/commit/425236370779308daad0ef9b783086798d951e23))
* **deps:** raise stable OpenTelemetry floors to ^2.12.0 ([#156](https://github.com/glassflow/rius-sdk-typescript/issues/156)) ([2c9c398](https://github.com/glassflow/rius-sdk-typescript/commit/2c9c39885741b1b2c31708134fcf4b98fbaad09e))
* recognise an @ai-sdk/otel run span by its usage details and move its total aside ([#138](https://github.com/glassflow/rius-sdk-typescript/issues/138)) ([2edea07](https://github.com/glassflow/rius-sdk-typescript/commit/2edea07b90bdd49af94a5b34951c0cb75dff5911))

## [1.3.0](https://github.com/glassflow/rius-sdk-typescript/compare/v1.2.0...v1.3.0) (2026-10-14)


### Features

* stamp gen_ai.main_agent.{id,name,description} on the resource next to rius.main_agent.* ([#135](https://github.com/glassflow/rius-sdk-typescript/issues/135)) ([9d4f1bc](https://github.com/glassflow/rius-sdk-typescript/commit/9d4f1bcf472f2b387673212e74c60e9d566d09fa))

## [1.2.0](https://github.com/glassflow/rius-sdk-typescript/compare/v1.1.1...v1.2.0) (2026-10-13)


### Features

* @arizeai/openinference-vercel is no longer needed and can be uninstalled ([f187227](https://github.com/glassflow/rius-sdk-typescript/commit/f187227b8ec248467da4cee17245e1a6c8cc8be0))
* client.ready no longer lists vercel-ai on AI SDK v5 and v6; it lists it only where @ai-sdk/otel is registered (AI SDK v7) ([f187227](https://github.com/glassflow/rius-sdk-typescript/commit/f187227b8ec248467da4cee17245e1a6c8cc8be0))
* map the Vercel AI SDK's ai.* telemetry onto the GenAI conventions natively ([#129](https://github.com/glassflow/rius-sdk-typescript/issues/129)) ([c8d52f0](https://github.com/glassflow/rius-sdk-typescript/commit/c8d52f02ae81e0aa301a7feecf4ea6283924d3eb))
* map the Vercel AI SDK's rerank spans natively, as the new RERANKER span kind (SpanKind.RERANKER) with the operation rerank ([f187227](https://github.com/glassflow/rius-sdk-typescript/commit/f187227b8ec248467da4cee17245e1a6c8cc8be0))
* record the reasoning split and classify agent_step on Vercel AI SDK v7 spans ([#133](https://github.com/glassflow/rius-sdk-typescript/issues/133)) ([94d32ba](https://github.com/glassflow/rius-sdk-typescript/commit/94d32bae23e5ed56aadbf6e18030abe8d3d78f60))


### Bug Fixes

* carry OpenTelemetry's telemetry.sdk.* keys on the resource ([#128](https://github.com/glassflow/rius-sdk-typescript/issues/128)) ([89761e6](https://github.com/glassflow/rius-sdk-typescript/commit/89761e6a342fbcc753d7a4d43f3123fa2bc81688))
* count a LangChain call's usage once when the provider span recorded it ([#131](https://github.com/glassflow/rius-sdk-typescript/issues/131)) ([3445882](https://github.com/glassflow/rius-sdk-typescript/commit/3445882a8ba0fdd443e76467a844a2b36181ed1f))
* record the negotiated MCP protocol version on every transport ([#127](https://github.com/glassflow/rius-sdk-typescript/issues/127)) ([da4323a](https://github.com/glassflow/rius-sdk-typescript/commit/da4323a7123860b3dc8da19a2ed30b28668821f5))

## [1.1.1](https://github.com/glassflow/rius-sdk-typescript/compare/v1.1.0...v1.1.1) (2026-10-13)


### Bug Fixes

* drop a request bag's tool definitions when llm.tools supplied them ([#120](https://github.com/glassflow/rius-sdk-typescript/issues/120)) ([064d112](https://github.com/glassflow/rius-sdk-typescript/commit/064d112af930be6b734742fc25171a2138b6c54b))
* map pydantic-ai's thinking_tokens and thoughts_tokens to the canonical reasoning count ([#119](https://github.com/glassflow/rius-sdk-typescript/issues/119)) ([8b11f6e](https://github.com/glassflow/rius-sdk-typescript/commit/8b11f6ef894c8fc0904d9596336ac47b8366df46))
* name a LangChain run's provider from ls_provider when no provider key is set ([#123](https://github.com/glassflow/rius-sdk-typescript/issues/123)) ([b6c703a](https://github.com/glassflow/rius-sdk-typescript/commit/b6c703a732c21d7d30d65cf263f6acb7361b6fcc))
* record OpenAI embeddings token counts the OpenInference instrumentation leaves out ([#124](https://github.com/glassflow/rius-sdk-typescript/issues/124)) ([066e896](https://github.com/glassflow/rius-sdk-typescript/commit/066e8969f2802a52ed9653671a891f050baee642))

## [1.1.0](https://github.com/glassflow/rius-sdk-typescript/compare/v1.0.0...v1.1.0) (2026-10-12)


### Features

* accept app-imported anthropic and openai modules in init() ([#107](https://github.com/glassflow/rius-sdk-typescript/issues/107)) ([83ee444](https://github.com/glassflow/rius-sdk-typescript/commit/83ee444a506329a9995f2ede85353e0a34fd30a8))


### Bug Fixes

* drop a LiteLLM routing prefix that names the span's provider from gen_ai.request.model ([#115](https://github.com/glassflow/rius-sdk-typescript/issues/115)) ([f9e751b](https://github.com/glassflow/rius-sdk-typescript/commit/f9e751b354dd86dfa0cffb39eac6d5b703df6106))
* map time to first chunk under its metric name, and give such spans a first-token event ([#116](https://github.com/glassflow/rius-sdk-typescript/issues/116)) ([6c533ee](https://github.com/glassflow/rius-sdk-typescript/commit/6c533eec31b395ab4474cab03952f1b71f32abfe))
* name the provider from llm.system when the host is unknown ([#111](https://github.com/glassflow/rius-sdk-typescript/issues/111)) ([1fe2b68](https://github.com/glassflow/rius-sdk-typescript/commit/1fe2b685d185adce56425d9629ed565d837648f6))
* never take a LangChain bag's stream member as the request's stream flag ([#117](https://github.com/glassflow/rius-sdk-typescript/issues/117)) ([b222300](https://github.com/glassflow/rius-sdk-typescript/commit/b2223004925e2862580a1838e30fd8f23dacdb9d))
* read the request model and max tokens from LlamaIndex's model metadata ([#118](https://github.com/glassflow/rius-sdk-typescript/issues/118)) ([451aecd](https://github.com/glassflow/rius-sdk-typescript/commit/451aecdf3cd67d82b310082d0981d1c0154eb956))
* require openinference-instrumentation-openai 4.4.1 and drop the rejected-call guard ([#112](https://github.com/glassflow/rius-sdk-typescript/issues/112)) ([7128b7c](https://github.com/glassflow/rius-sdk-typescript/commit/7128b7c61beaeabb00f96a499895e3cb7e8de80b))
* stop double-counting AI SDK v7 usage on the invoke_agent span ([#110](https://github.com/glassflow/rius-sdk-typescript/issues/110)) ([0e2d98b](https://github.com/glassflow/rius-sdk-typescript/commit/0e2d98b9445f5efa18523d2b732950b5a6387951))
* warn when a declared anthropic or openai integration cannot load ([#109](https://github.com/glassflow/rius-sdk-typescript/issues/109)) ([d1ad014](https://github.com/glassflow/rius-sdk-typescript/commit/d1ad01409b1c20af7329a578147ba4c151cab909))

## [1.0.0](https://github.com/glassflow/rius-sdk-typescript/compare/v0.8.0...v1.0.0) (2026-09-29)

### Upgrading from 0.x

Version 1.0.0 finishes the move from the GlassFlow name to Rius and brings span names in line with the OpenTelemetry GenAI conventions. It needs the Rius platform release of 2026-09-29 or later, which accepts `rius.span.pending`.

**Breaking changes and how to migrate**

| What changed | What to do |
|---|---|
| The pending-span attribute is now `rius.span.pending`, not `glassflow.span.pending` (#67) | Update any code that imports the constant. |
| The tracer scope is now `rius`, not `glassflow` (#67) | Update any collector or processor rule that filters on the instrumentation scope. |
| Span names follow the GenAI conventions: `chat {model}`, `embeddings {model}`, `execute_tool {tool}`, `invoke_agent {agent}`, `retrieval {data_source}`. CHAIN spans keep the function name, and an explicit name still wins (#72) | Update saved searches, alerts and dashboards that are keyed on span name, or pass an explicit name. |
| RETRIEVER spans carry `gen_ai.operation.name="retrieval"` and accept `dataSourceId` (#69) | Update any filter on the old operation name. |
| `modelParameters` maps 43 aliases onto 15 standard `gen_ai.request.*` keys, and unknown keys go under `rius.request.*` (#85) | Filter on the standard keys. |
| The `@arizeai/openinference-instrumentation-anthropic` peer now needs `^0.2.7`, the first version that reports prompt-cache tokens (#96) | Upgrade that peer dependency. |

**Behaviour changes**

- The span helpers take `toolName`, so the tool name no longer has to come from the span name (#68).
- A span can carry up to 4096 attributes, up from 128, so long agent calls keep their usage and output (#95).
- With `captureContent: false`, the OpenInference request-parameter bag (`llm.invocation_parameters`) is treated as content and is not sent (#87).
- **Other OpenTelemetry SDKs in the same process** (Langfuse, Traceloop, Logfire, MLflow, OpenLIT, Laminar): when one of them owns the global tracer provider, Rius can now bridge it, so that their spans (your LLM calls' parents) reach Rius too. The bridge is off by default. Turn it on with `bridgeForeignProvider: true` or `RIUS_BRIDGE_FOREIGN_PROVIDER=1`. Spans whose parent Rius never saw are flagged `rius.parent.foreign` either way (#104).
- With `captureContent: false`, the Laminar `lmnr.*` content keys are stripped too (#105).

Node 18+ is still supported, and the package name (`@glassflow-ai/rius`) is unchanged.



### ⚠ BREAKING CHANGES

* normalize modelParameters keys onto gen_ai.request.* and rius.request.* ([#85](https://github.com/glassflow/rius-sdk-typescript/issues/85))
* name spans after their operation and target, per the conventions ([#72](https://github.com/glassflow/rius-sdk-typescript/issues/72))
* map RETRIEVER to the retrieval operation and take a data source id ([#69](https://github.com/glassflow/rius-sdk-typescript/issues/69))
* emit rius.span.pending and the rius tracer scope ([#67](https://github.com/glassflow/rius-sdk-typescript/issues/67))

### Features

* emit rius.context.sizes, a per-part byte breakdown of the context, on every generation span ([#65](https://github.com/glassflow/rius-sdk-typescript/issues/65)) ([5066d77](https://github.com/glassflow/rius-sdk-typescript/commit/5066d77c185d76cdf7bdc00392850ad80026b204))
* emit rius.span.pending and the rius tracer scope ([#67](https://github.com/glassflow/rius-sdk-typescript/issues/67)) ([6cbd4fa](https://github.com/glassflow/rius-sdk-typescript/commit/6cbd4fa0c29d0630ed663be4c81ea28d38b5bf04))
* map llm.finish_reason onto gen_ai.response.finish_reasons, verbatim ([#84](https://github.com/glassflow/rius-sdk-typescript/issues/84)) ([5aa533b](https://github.com/glassflow/rius-sdk-typescript/commit/5aa533b759875d2d2af1cb652e87b002c1913d34))
* map OpenInference embeddings and the response id onto the canonical keys ([#100](https://github.com/glassflow/rius-sdk-typescript/issues/100)) ([337050c](https://github.com/glassflow/rius-sdk-typescript/commit/337050cfef27608fa1881ed73f67889356de5863))
* map RETRIEVER to the retrieval operation and take a data source id ([#69](https://github.com/glassflow/rius-sdk-typescript/issues/69)) ([18d7404](https://github.com/glassflow/rius-sdk-typescript/commit/18d7404f9849cc65414505699fc476cef57ffdd3))
* map the OpenInference model-call, usage and taxonomy keys onto the canonical wire ([#81](https://github.com/glassflow/rius-sdk-typescript/issues/81)) ([3d93ec6](https://github.com/glassflow/rius-sdk-typescript/commit/3d93ec6965d842a46e9ed86cfb54a56137977b3d))
* map tool.name, the llm.tools definitions and two usage spellings onto the canonical wire ([#91](https://github.com/glassflow/rius-sdk-typescript/issues/91)) ([02211bb](https://github.com/glassflow/rius-sdk-typescript/commit/02211bb0c678a7bbf917fef46b99e18df79d91ae))
* name spans after their operation and target, per the conventions ([#72](https://github.com/glassflow/rius-sdk-typescript/issues/72)) ([b1610c1](https://github.com/glassflow/rius-sdk-typescript/commit/b1610c128e00e0ad088f4cda12c9bd6f56220133))
* name the agent an AGENT span invokes ([#71](https://github.com/glassflow/rius-sdk-typescript/issues/71)) ([13f30c3](https://github.com/glassflow/rius-sdk-typescript/commit/13f30c3225058edf81d28602a09faaca4fed368e))
* name the agent executing a tool on execute-tool spans ([#75](https://github.com/glassflow/rius-sdk-typescript/issues/75)) ([e7c15d3](https://github.com/glassflow/rius-sdk-typescript/commit/e7c15d394403ec1cacfabdaf960e0173c9ef0574))
* normalize modelParameters keys onto gen_ai.request.* and rius.request.* ([#85](https://github.com/glassflow/rius-sdk-typescript/issues/85)) ([d348a9f](https://github.com/glassflow/rius-sdk-typescript/commit/d348a9f83e3a3d55f9766fa22785094b757911ef))
* normalize third-party attribute dialects to the conventions ([#76](https://github.com/glassflow/rius-sdk-typescript/issues/76)) ([6f45a0a](https://github.com/glassflow/rius-sdk-typescript/commit/6f45a0a4d1083783304bebe450c6e940c4a4a21a))
* reassemble OpenInference's flattened messages, Anthropic's multi-part contents included ([#90](https://github.com/glassflow/rius-sdk-typescript/issues/90)) ([2a835db](https://github.com/glassflow/rius-sdk-typescript/commit/2a835db5a8c0a5cd145354fd0773a132bd60e050))
* record the completion id, output type and tool-call identity, and stamp service.version ([#77](https://github.com/glassflow/rius-sdk-typescript/issues/77)) ([056437d](https://github.com/glassflow/rius-sdk-typescript/commit/056437d4db95a98ac3453ede9638d37fb2845abd))
* take gen_ai.tool.name as an explicit argument on the span helpers ([#68](https://github.com/glassflow/rius-sdk-typescript/issues/68)) ([b664edb](https://github.com/glassflow/rius-sdk-typescript/commit/b664edb10266028bc903b94e4a648e17d371cf5a))
* take the process agent identity into rius.main_agent.*, and version the agent at both scopes ([#79](https://github.com/glassflow/rius-sdk-typescript/issues/79)) ([e8c7886](https://github.com/glassflow/rius-sdk-typescript/commit/e8c788621246e2623ada3a0f321b6aebdafc35ac))


### Bug Fixes

* bridge a foreign global OTel provider and flag foreign parents (RIUS-1097) ([#104](https://github.com/glassflow/rius-sdk-typescript/issues/104)) ([6b2b111](https://github.com/glassflow/rius-sdk-typescript/commit/6b2b1110489fd5524f2de61e684d9d7a58f93096))
* carry the Anthropic system prompt as a system input message ([#98](https://github.com/glassflow/rius-sdk-typescript/issues/98)) ([1b245c6](https://github.com/glassflow/rius-sdk-typescript/commit/1b245c640ad1891abcee985fc82a2ccc1a2be662))
* end the OpenAI span when an auto-instrumented call rejects ([#99](https://github.com/glassflow/rius-sdk-typescript/issues/99)) ([a324fef](https://github.com/glassflow/rius-sdk-typescript/commit/a324fefadae4522f7284b832d7d0b979e302da83))
* guard native modelParameters like the normalizer, and let the first spelling win ([#93](https://github.com/glassflow/rius-sdk-typescript/issues/93)) ([68b85d1](https://github.com/glassflow/rius-sdk-typescript/commit/68b85d19c7ae19817459321242539171c540817d))
* keep tool_choice with content capture off by promoting it out of the request bag ([#94](https://github.com/glassflow/rius-sdk-typescript/issues/94)) ([8cc97c3](https://github.com/glassflow/rius-sdk-typescript/commit/8cc97c330380d826b59c21f8a448e0e38bc02eee))
* leave U+2028/U+2029 raw in a promoted system block, as the sink writes them ([#101](https://github.com/glassflow/rius-sdk-typescript/issues/101)) ([552f4cc](https://github.com/glassflow/rius-sdk-typescript/commit/552f4cca6746970a1628b2bc3c6c7e3d7e102dc8))
* name provider SDK errors by class in error.type and exception.type ([#92](https://github.com/glassflow/rius-sdk-typescript/issues/92)) ([11c6dea](https://github.com/glassflow/rius-sdk-typescript/commit/11c6dea00a0c54ad9903822d1de802b47147ccfc))
* raise the span attribute limit so long agent calls keep their usage and output ([#95](https://github.com/glassflow/rius-sdk-typescript/issues/95)) ([2918a8b](https://github.com/glassflow/rius-sdk-typescript/commit/2918a8bbbc1fb4191d865f2f81e3efbce5ce95d4))
* require the Anthropic instrumentor version that reports prompt-cache tokens ([#96](https://github.com/glassflow/rius-sdk-typescript/issues/96)) ([eb86f0f](https://github.com/glassflow/rius-sdk-typescript/commit/eb86f0f6a1710c083317d58c50e4eab18ed61c9a))
* run the Vercel transform only on the AI SDK's own ai.* spans ([#97](https://github.com/glassflow/rius-sdk-typescript/issues/97)) ([fc0729f](https://github.com/glassflow/rius-sdk-typescript/commit/fc0729fdc898bfe4f4f80916db053dbccf86e2f8))
* stamp gen_ai.agent.name on the resource ([#70](https://github.com/glassflow/rius-sdk-typescript/issues/70)) ([22f3423](https://github.com/glassflow/rius-sdk-typescript/commit/22f34235f30f6f65eb40d5c49f9acf254367945b))
* strip Laminar (lmnr.*) content keys with captureContent off (RIUS-1070) ([#105](https://github.com/glassflow/rius-sdk-typescript/issues/105)) ([3ae1929](https://github.com/glassflow/rius-sdk-typescript/commit/3ae192967b02c9453dd3316615a321aa3c1aa6ad))
* treat the OpenInference request-parameter bag as content ([#87](https://github.com/glassflow/rius-sdk-typescript/issues/87)) ([6eccc66](https://github.com/glassflow/rius-sdk-typescript/commit/6eccc66699221cab4ff7636307d07b68e5aa2b22))
* write U+2028/U+2029 raw in a promoted tool_choice, as the sink does ([#103](https://github.com/glassflow/rius-sdk-typescript/issues/103)) ([3178bc5](https://github.com/glassflow/rius-sdk-typescript/commit/3178bc53cdf5b74730e8efe768b24f9a5788470b))

## [0.8.0](https://github.com/glassflow/rius-sdk-typescript/compare/v0.7.0...v0.8.0) (2026-09-21)


### Features

* emit gen_ai.response.time_to_first_chunk alongside the first-token event ([#62](https://github.com/glassflow/rius-sdk-typescript/issues/62)) ([a589aed](https://github.com/glassflow/rius-sdk-typescript/commit/a589aed706a3b106637b276f7a954cc9135a6901))
* set gen_ai.tool.name on local tool spans ([#60](https://github.com/glassflow/rius-sdk-typescript/issues/60)) ([5678445](https://github.com/glassflow/rius-sdk-typescript/commit/56784453d5c6baa4ec8ba2e4e182a66d9a11a3c2))
* set the OTel SpanKind field from the span taxonomy ([#61](https://github.com/glassflow/rius-sdk-typescript/issues/61)) ([802a70d](https://github.com/glassflow/rius-sdk-typescript/commit/802a70dcb98f731545392fa712aeb96a6f5ef211))


### Bug Fixes

* set error.type on inference and generic spans ([#59](https://github.com/glassflow/rius-sdk-typescript/issues/59)) ([e602c2d](https://github.com/glassflow/rius-sdk-typescript/commit/e602c2d2691adc9445ae8f69cb86fc7f67f00dde))

## [0.7.0](https://github.com/glassflow/rius-sdk-typescript/compare/v0.6.1...v0.7.0) (2026-09-21)


### Features

* bring MCP client spans onto the OTel MCP semantic conventions ([#54](https://github.com/glassflow/rius-sdk-typescript/issues/54)) ([2b1d01d](https://github.com/glassflow/rius-sdk-typescript/commit/2b1d01dd1b8caed164b17a2adcc4eccb6ae87dbd))


### Bug Fixes

* set error.type on MCP tool-call spans ([#58](https://github.com/glassflow/rius-sdk-typescript/issues/58)) ([a492221](https://github.com/glassflow/rius-sdk-typescript/commit/a492221eab0f7b7cde31b75e1aced369e972aad9))

## [0.6.1](https://github.com/glassflow/rius-sdk-typescript/compare/v0.6.0...v0.6.1) (2026-09-14)


### Bug Fixes

* **masking:** treat metadata.* mirrors of content keys as content ([#52](https://github.com/glassflow/rius-sdk-typescript/issues/52)) ([0bffd0b](https://github.com/glassflow/rius-sdk-typescript/commit/0bffd0b6955517fe97da69c9dfc0ea21e29f4288))

## [0.6.0](https://github.com/glassflow/rius-sdk-typescript/compare/v0.5.0...v0.6.0) (2026-09-14)


### Features

* **parity:** normalise messages, bound payloads at 32 KB, and carry SDK identity on the wire ([#50](https://github.com/glassflow/rius-sdk-typescript/issues/50)) ([d49a9f4](https://github.com/glassflow/rius-sdk-typescript/commit/d49a9f415c3a7254a0822be4fabae2d7a239aaa3))
* record tool definitions in the generation API and pin instrumentor tool capture ([#40](https://github.com/glassflow/rius-sdk-typescript/issues/40)) ([74742b3](https://github.com/glassflow/rius-sdk-typescript/commit/74742b3d254dd3e3bb2c4a0f33889d348d4d03b7))
* trace Vercel AI SDK v7 apps zero-config via registerTelemetry + @ai-sdk/otel ([#43](https://github.com/glassflow/rius-sdk-typescript/issues/43)) ([017d962](https://github.com/glassflow/rius-sdk-typescript/commit/017d962a8047a6689125dbc542bdc664b96c7335))
* withUser stamps user.id on every span in scope ([#44](https://github.com/glassflow/rius-sdk-typescript/issues/44)) ([1c89654](https://github.com/glassflow/rius-sdk-typescript/commit/1c89654075feeea212a07170c87d228d27fedab4))


### Bug Fixes

* **client:** shutdown() undoes the instrumentation it enabled ([#46](https://github.com/glassflow/rius-sdk-typescript/issues/46)) ([f03dc53](https://github.com/glassflow/rius-sdk-typescript/commit/f03dc53c9404411e1b13cd9ab5f96ae13a2bf8af))
* **masking:** cover the GenAI tool-call keys and run the mask over the status message ([#45](https://github.com/glassflow/rius-sdk-typescript/issues/45)) ([37fdcf0](https://github.com/glassflow/rius-sdk-typescript/commit/37fdcf0c06f2f9c38dcdde36034a4619c39aae2b))
* robustness edge cases from the 2026-09-14 review ([#48](https://github.com/glassflow/rius-sdk-typescript/issues/48)) ([2722d5a](https://github.com/glassflow/rius-sdk-typescript/commit/2722d5ae9fc1f445a421a2c8c64dd0a1a348389e))
* strip tool definitions and Vercel ai.* content on every sanitized path ([#42](https://github.com/glassflow/rius-sdk-typescript/issues/42)) ([51685b4](https://github.com/glassflow/rius-sdk-typescript/commit/51685b409dacbb0dea82e9614009968cbde25bfe))

## [0.5.0](https://github.com/glassflow/rius-sdk-typescript/compare/v0.4.0...v0.5.0) (2026-09-10)


### Features

* capture reasoning output tokens in setUsage ([#36](https://github.com/glassflow/rius-sdk-typescript/issues/36)) ([870f61b](https://github.com/glassflow/rius-sdk-typescript/commit/870f61b299635f0337c27245ede13e1a27f8ee57))
* capture requested reasoning effort level ([#38](https://github.com/glassflow/rius-sdk-typescript/issues/38)) ([4d9ee35](https://github.com/glassflow/rius-sdk-typescript/commit/4d9ee35119cc1d37d973ce1a23d2e458be95f617))


### Bug Fixes

* sum Anthropic cache tokens into the emitted input-token total ([#39](https://github.com/glassflow/rius-sdk-typescript/issues/39)) ([842a0a9](https://github.com/glassflow/rius-sdk-typescript/commit/842a0a92546d4ec8ef7dc43738fd7e79c606a7f7))

## [0.4.0](https://github.com/glassflow/rius-sdk-typescript/compare/v0.3.1...v0.4.0) (2026-09-10)


### Features

* add cache-token fields to setUsage ([#30](https://github.com/glassflow/rius-sdk-typescript/issues/30)) ([116c7b0](https://github.com/glassflow/rius-sdk-typescript/commit/116c7b0986f8a4fc541381ab401138f552fa0044))
* context-scoped multi-workspace routing (withWorkspace + routing exporter) ([#33](https://github.com/glassflow/rius-sdk-typescript/issues/33)) ([546a4ff](https://github.com/glassflow/rius-sdk-typescript/commit/546a4ff9ff580a49a6a204ac5007155abcd3e309))


### Bug Fixes

* emit gen_ai.usage.cache_write.input_tokens per the semconv rename ([#34](https://github.com/glassflow/rius-sdk-typescript/issues/34)) ([812529b](https://github.com/glassflow/rius-sdk-typescript/commit/812529b2bc072b45b6bba814e703c5f20d25712f))
* strip tool definitions and descriptions when content capture is off ([#35](https://github.com/glassflow/rius-sdk-typescript/issues/35)) ([f5cca4c](https://github.com/glassflow/rius-sdk-typescript/commit/f5cca4c1a55e2ad506823f102459f05cd5a226df))

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
