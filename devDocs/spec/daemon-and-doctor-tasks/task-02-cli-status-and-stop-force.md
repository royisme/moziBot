# Task 02 — CLI Status and Stop Force

## Status
planned

## Objective
Build the Phase 1 CLI lifecycle layer on top of Task 01: richer `mozi status`, `--json` output, and `mozi stop --force` with timeout and SIGKILL fallback using the centralized runtime artifact contract.

## Inputs / Prerequisites
- `CLAUDE.md`
- `devDocs/spec/daemon-and-doctor.md`
- `devDocs/spec/daemon-and-doctor-tasks/task-01-runtime-status-and-shutdown.md`
- status/PID ownership and freshness behavior produced by Task 01

## Implementation Notes
- Depend on Task 01 as the only source of truth for runtime artifact paths and stale/fresh interpretation.
- `mozi status` should render degraded states from stale or unreadable status artifacts without crashing the CLI.
- Add `--json` output for Phase 1 status only; keep the schema aligned with the runtime status model and CLI-friendly summary fields.
- `mozi stop --force` must use strict stop semantics: SIGTERM first, wait until timeout, then SIGKILL only when `--force` is explicitly set.
- Cleanup of runtime-owned artifacts should happen through the lifecycle/shutdown ownership model established by Task 01, not through ad hoc command-only logic.
- Coordinate carefully around `src/cli/index.ts` because Task 04 will also need CLI command registration.

## Deliverables
- enhanced `mozi status` human-readable output
- `mozi status --json`
- `mozi stop --force`
- timeout polling and SIGKILL fallback path
- stale/degraded status rendering that respects freshness rules from Task 01

## Validation Expectations
- running, stopped, stale-status, unreadable-status, and stale-PID scenarios are rendered correctly
- `--json` output is stable and machine-readable for Phase 1 fields
- force-stop only escalates to SIGKILL when requested
- timeout failures remain user-visible when `--force` is not set
- `pnpm run check` passes
- `pnpm run test` passes, or failures are shown to be pre-existing and unrelated
- manual verification covers stopped/running/stale-status/force-stop scenarios

## Dependencies
- `task-01-runtime-status-and-shutdown.md`

## Blockers
- Cannot proceed until Task 01 lands because status interpretation and artifact ownership must not be redefined in the CLI layer.
