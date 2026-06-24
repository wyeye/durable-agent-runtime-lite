# Evaluation And Visual Config

Evaluation 覆盖 Dataset、Case、Gate Policy、Run、Case Result、Comparison、Gate Decision、Override 和 Evidence。Publish Gate 基于 exact candidate bundle hash、dataset hash、gate policy hash 与 evidence 状态。

Control-plane writable config 使用 visual forms：

- Registry resources。
- Evaluation Dataset、Case、Gate Policy。
- Flow ordered steps builder。
- ModelPolicy exact ModelDefinition selection。

JSON 只读展示，不作为写入入口。

Ollama Evaluation Gate 是 self-hosted/manual 路径，要求 exact model `qwen2.5:7b-instruct-q4_K_M`，并验证 ModelCall、ToolCall、HumanTask、Evidence、Gate Decision 和 DB 证据。
