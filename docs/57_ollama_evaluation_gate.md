# Ollama Evaluation Gate

This is the AR-2B-FINAL-GATE manual validation path for proving real Evaluation execution with host Ollama and the four Dockerized production apps.

## Status

The platform version remains `0.8.0`.

No tag, GitHub Release, or version promotion is performed by this gate.

## Boundaries

- Production apps remain exactly `control-plane`, `runtime-api`, `runtime-worker`, and `tool-gateway`.
- Ollama runs on the host only.
- Exact model: `qwen2.5:7b-instruct-q4_K_M`.
- The app containers must not include Ollama or model files.
- `mock-server` must not run.
- `PI_AGENT_MODE=deterministic` must not be enabled.
- Tool execution must go through Tool Gateway.
- Evaluation must go through Temporal `EvaluationRunWorkflow` and `EvaluationCaseWorkflow`.

## Runtime Path

```text
control-plane API
  -> Temporal EvaluationRunWorkflow
  -> EvaluationCaseWorkflow
  -> Pi Agent Core
  -> Ollama OpenAI-compatible API
  -> Tool Gateway
  -> Evidence Collector
  -> Scoring
  -> Gate Decision
  -> PostgreSQL
```

## Compose Overlay

`infra/docker-compose.ollama.yml` enables the development/test local Ollama profile:

```text
PI_AGENT_MODE=model_gateway
MODEL_GATEWAY_MODE=openai_compatible
MODEL_GATEWAY_PROTOCOL=openai_chat_completions
MODEL_GATEWAY_PROFILE_ID=local-ollama
MODEL_GATEWAY_BASE_URL=http://host.docker.internal:11434/v1
MODEL_GATEWAY_API_KEY=ollama
MODEL_GATEWAY_MODEL=qwen2.5:7b-instruct-q4_K_M
MODEL_GATEWAY_ALLOW_INSECURE_HTTP=true
EVALUATION_WORKER_ENABLED=true
EVALUATION_TASK_QUEUE=evaluation-worker-main
EVALUATION_MAX_CONCURRENT_RUNS=1
EVALUATION_MAX_CONCURRENT_CASES=1
EVALUATION_CASE_TIMEOUT_MS=300000
```

`control-plane` keeps `EVALUATION_GATE_MODE=required` through the base compose file.

## Smoke Command

```bash
corepack pnpm smoke:evaluation-ollama-e2e
```

The smoke creates exactly three independent Evaluation Runs:

- `final`: no tools, exact `local-ollama` ModelPolicy, temperature `0`, final-only prompt.
- `readonly`: only `knowledge.search`, first turn tool choice required, second turn tool choice none.
- `l3`: only `record.write.mock`, first turn tool choice required, sandbox commit policy, Human Task approval through runtime-api, second turn tool choice none.

## Evidence Assertions

The smoke checks PostgreSQL evidence across:

- `evaluation_run`
- `evaluation_case_result`
- `evaluation_subject_snapshot`
- `evaluation_execution_plan`
- `task_run`
- `agent_run`
- `model_call_log`
- `model_call_attempt`
- `tool_call_log`
- `human_task`
- `audit_event`
- `idempotency_record`

Required evidence:

- `provider=local-ollama`
- `model=qwen2.5:7b-instruct-q4_K_M`
- no deterministic or mock model evidence
- exact Candidate Bundle hash
- exact Dataset hash
- exact Gate Policy hash
- Evidence `completeness_status=complete`
- secret leak count `0`
- hidden reasoning leak count `0`
- forbidden tool count `0`
- duplicate tool count `0`
- duplicate commit count `0`
- readonly tool call exactly once
- L3 Human Task exactly one and approved
- L3 commit exactly once
- Gate Decision references the exact Candidate Bundle hash

## Self-Hosted Workflow

`.github/workflows/ollama-runtime.yml` is manual only:

```text
workflow_dispatch
runs-on: [self-hosted, ollama]
```

The runner must already have Docker, Ollama, and `qwen2.5:7b-instruct-q4_K_M`. The workflow does not download the 7B model on GitHub-hosted runners.

The order is:

```text
build
start dependencies
migrate
seed local Ollama + Evaluation data
start four app containers
assert containerized
ollama probe
runtime final
runtime readonly
runtime L3
evaluation Ollama
replay
diagnostics
down
```

Failures fail the job. Diagnostics redact service tokens and are safe summaries only.

## Completion Rule

Only mark AR-2B as `AR-2B DEVELOPMENT COMPLETE` when the current SHA has:

- four production images rebuilt with matching `/version` SHA;
- four app containers healthy;
- Evaluation Worker running;
- exact host Ollama model available;
- `smoke:ollama-containerized-e2e` passed;
- `smoke:evaluation-ollama-e2e` passed;
- backend Evaluation framework smoke passed;
- lint/typecheck/test/build/replay passed;
- logs checked for secret/raw prompt/raw provider response leakage;
- no tag, no GitHub Release, and version still `0.8.0`.

## Local Final Result

The 2026-06-22 local AR-2B-FINAL-GATE run satisfied the completion rule for HEAD `dc95bcb6811d576201268205893171ab427ce6c0`: four production images were rebuilt, four app containers were healthy, `/version` reported the matching build SHA, Evaluation Worker was running, host Ollama served exact model `qwen2.5:7b-instruct-q4_K_M`, runtime final/readonly/L3 and Evaluation final/readonly/L3 smokes passed, backend Evaluation framework regression passed, logs were safety-scanned, and no tag, GitHub Release, or version promotion was performed.
