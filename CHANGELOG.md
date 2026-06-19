# Changelog

## 0.8.0

- Added ModelPolicy as the frozen model execution source of truth.
- Added OpenAI-compatible Model Gateway client support and model call ledger tables.
- Locked AgentExecutionPlan to exact ModelPolicy id/version/hash.
- Added control-plane ModelPolicy registry access and version consistency checks.
