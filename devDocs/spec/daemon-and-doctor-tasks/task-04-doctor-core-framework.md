# Task 04 — Doctor Core Framework

## Status
planned

## Objective
Implement the Phase 1 `mozi doctor` foundation: doctor types, check registry, runner, reporter, CLI command wiring, and the small core check set defined for environment, config, runtime, and storage.

## Inputs / Prerequisites
- `CLAUDE.md`
- `devDocs/spec/daemon-and-doctor.md`
- `devDocs/spec/daemon-and-doctor-tasks/task-01-runtime-status-and-shutdown.md`
- runtime status/freshness behavior from Task 01 for runtime checks
- existing config, storage, and health-related repository utilities

## Implementation Notes
- Keep Phase 1 doctor file/process based only; no dependency on future IPC, provider connectivity, or channel health checks.
- Implement the registry/runner/reporter split so future phases can add checks without rewriting orchestration.
- Core Phase 1 categories/checks should be limited to the spec’s environment, config, runtime, and storage set.
- Runtime checks must consume Task 01’s artifact ownership and freshness semantics instead of redefining them.
- CLI output should support the initial human-readable doctor report and appropriate nonzero exit behavior for failures as designed.
- Coordinate carefully around `src/cli/index.ts` because Task 02 will also touch command registration.

## Deliverables
- doctor types, registry, runner, reporter, and entrypoint
- `mozi doctor` CLI command wiring
- Phase 1 core checks only:
  - environment
  - config
  - runtime
  - storage
- summary/exit behavior suitable for scripting and troubleshooting

## Validation Expectations
- doctor runs successfully without requiring future phase features
- failures/warnings are reported through the shared reporter with clear category/check output
- runtime checks correctly interpret stale/fresh runtime artifacts from Task 01
- exit behavior matches the designed Phase 1 doctor contract
- `pnpm run check` passes
- `pnpm run test` passes, or failures are shown to be pre-existing and unrelated
- manual verification confirms core checks and expected nonzero exit behavior on failure states

## Dependencies
- `task-01-runtime-status-and-shutdown.md`

## Blockers
- Cannot proceed until Task 01 lands because runtime checks must depend on the canonical status artifact contract.
