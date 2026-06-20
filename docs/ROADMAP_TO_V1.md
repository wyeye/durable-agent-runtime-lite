# Roadmap To V1

## R0 Platform Core Freeze

Status: complete for version and baseline documentation, with AR-2A marked implementation complete and no version promotion.

- Freeze AR-1 core architecture.
- Keep exactly four production apps.
- Use root `package.json` version as the version source of truth.
- Keep deterministic Pi and mock Model Gateway as development/test-only paths.

## AR-2 Intelligence RC

Target version line: `0.9.0-rc.x`.

Required before first RC:

- Complete protected live model smoke against a real OpenAI-compatible gateway.
- Prove live final, readonly tool, and L3 tool paths through runtime-api, Temporal, runtime-worker, Tool Gateway, and Pi.
- Add live model workflow dispatch using GitHub environment secrets.
- Finish local fallback/crash model-gateway smoke coverage for provider response persistence and replay.

## V1 GA

Target version: `1.0.0`.

Required before GA:

- All release criteria in `docs/V1_RELEASE_CRITERIA.md`.
- No production fallback to sample, mock, memory, stale, or unrelated data paths.
- Docker build and runtime readiness for all four production apps.
- Temporal replay and crash recovery gates passing from current exported histories.
