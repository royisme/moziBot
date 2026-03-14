# Task 03 — CLI Restart

## Status
planned

## Objective
Add a thin Phase 1 `mozi restart` command that strictly orchestrates stop + start behavior using the existing command/runtime lifecycle rather than introducing in-process reload or alternate restart logic.

## Inputs / Prerequisites
- `CLAUDE.md`
- `devDocs/spec/daemon-and-doctor.md`
- `devDocs/spec/daemon-and-doctor-tasks/task-02-cli-status-and-stop-force.md`
- final stop/start orchestration behavior from Tasks 01 and 02

## Implementation Notes
- Keep restart intentionally thin: reuse stop/start behavior rather than duplicating lifecycle logic.
- Do not add hot reload, signal-driven reexec, or any service-manager semantics in this task.
- Define and document Phase 1 behavior for running vs already-stopped states and error propagation.
- If restart needs force-stop semantics, route through the existing stop path rather than reimplementing timeout/SIGKILL behavior.

## Deliverables
- `mozi restart` command wiring
- strict stop-then-start orchestration
- user-visible behavior for already-stopped and error states consistent with the Phase 1 CLI contract

## Validation Expectations
- restart works from running state using the existing stop/start flow
- restart behavior from stopped/error states is explicit and consistent with chosen CLI semantics
- no duplicate lifecycle logic is introduced
- `pnpm run check` passes
- `pnpm run test` passes, or failures are shown to be pre-existing and unrelated
- manual verification covers running and stopped/error-state restart behavior

## Dependencies
- `task-02-cli-status-and-stop-force.md`

## Blockers
- Cannot proceed until Task 02 lands because restart must reuse the finalized stop/start orchestration path.
