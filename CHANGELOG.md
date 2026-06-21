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
