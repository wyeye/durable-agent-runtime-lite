# Changelog

## 0.8.0

- Added ModelPolicy as the frozen model execution source of truth.
- Added OpenAI-compatible Model Gateway client support and model call ledger tables.
- Locked AgentExecutionPlan to exact ModelPolicy id/version/hash.
- Added control-plane ModelPolicy registry access and version consistency checks.
- Added Docker image build metadata, `/version` endpoints, trimmed runtime images, and containerized Ollama release-gate scripts.
- Added opt-in local Ollama seed policy for exact model `qwen2.5:7b-instruct-q4_K_M`.
- Added self-hosted Ollama runtime workflow scaffold for manual release validation.
- Added AR-2B backend Evaluation smoke commands for framework, regression gate, and publish gate paths.
- Added Evaluation Temporal history export support for run success, case success, and case system-error replay fixtures.
- Wired Evaluation backend smokes and replay into the Integration workflow without adding a production app, container, tag, release, or version change.
- Added AR-2B Evaluation control-plane UI for datasets/cases, runs/results/comparison, gate policies/decisions/overrides, registry Gate Cards, and Playwright Evaluation UI smoke command.
- Added shared fullstack i18n foundation for `zh-CN`, including API messages, Zod issue localization, deployment-level log messages, audit display localization, and control-plane Chinese UI copy.
- Replaced writable control-plane JSON configuration flows with visual editors for Registry resources, Evaluation Dataset/Case/Gate Policy, read-only JSON preview, exact version selectors, structured value/schema editors, round-trip tests, and `visual-config:check`.
- Added the AR-2B-FINAL-GATE Ollama Evaluation smoke command for final/readonly/L3 Evaluation Runs, Evaluation Worker compose enablement, self-hosted Ollama workflow gate integration, and DB evidence assertions for ModelCall, ToolCall, HumanTask, Evidence, Scoring, and Gate Decision paths.
- Added MODEL-CATALOG-MVP-1 multi OpenAI-compatible gateway catalog support, AES-256-GCM encrypted model credentials, model definition pages/APIs, exact ModelPolicy `model_ref` targets, DB-backed Runtime Worker model resolution, credential-rotation cache invalidation, and the `pnpm dar smoke run model-catalog` path.
- Added PILOT-HTTP-TOOL-1 working-tree support for a generic GET-only `http_readonly` Tool Adapter, Tool Adapter Dispatcher, Host allowlist and SSRF policy, env secret refs, response limits, output-schema validation, control-plane visual fields, mock external policy API, and `pnpm dar smoke run http-readonly-tool`.
- Updated `pnpm dar smoke run http-readonly-tool` to prove semantic route -> Flow -> Agent Child Workflow -> Pi -> Tool Gateway -> `http_readonly` -> external mock API -> final answer, while keeping the external API as `devtools/mock-server`.
