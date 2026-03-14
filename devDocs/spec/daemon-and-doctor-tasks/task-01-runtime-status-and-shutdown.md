# Task 01 — Runtime Status and Shutdown

## Status
planned

## Objective
Implement the Phase 1 runtime lifecycle foundation: authoritative runtime status artifacts, atomic status-file writes, freshness semantics, graceful shutdown cleanup, and centralized ownership of transient daemon artifacts.

## Inputs / Prerequisites
- `CLAUDE.md`
- `devDocs/spec/daemon-and-doctor.md`
- existing daemon/runtime lifecycle code in `src/cli/commands/start.ts` and runtime host files
- existing PID / runtime artifact behavior in the repository

## Implementation Notes
- Treat this task as the source of truth for PID/status-path ownership in Phase 1.
- Keep artifact ownership centralized between runtime host lifecycle and daemon helpers; do not spread cleanup logic across unrelated CLI commands.
- Add a dedicated runtime status model and status writer with atomic temp-write + rename semantics.
- Define and implement freshness rules using `updatedAt`; stale snapshots must remain inspectable and must not be deleted except during graceful shutdown of the owning process.
- Runtime shutdown must explicitly clean up transient artifacts it owns on graceful exit.
- Keep the implementation file/process based only; do not introduce IPC or service-manager abstractions in this task.

## Deliverables
- runtime status types and artifact-path ownership contract
- atomic status writer implementation
- periodic status refresh from runtime host
- graceful shutdown cleanup path that removes runtime-owned transient artifacts on orderly exit
- any required runtime/daemon helper changes to make lifecycle ownership explicit and reusable by later tasks

## Validation Expectations
- foreground and daemon runtime paths both produce consistent status artifacts
- status file writes are atomic and leave no partially written snapshots
- freshness semantics are explicit and testable from CLI readers
- graceful shutdown removes owned transient artifacts without deleting evidence needed for stale/crash detection
- `pnpm run check` passes
- `pnpm run test` passes, or failures are shown to be pre-existing and unrelated
- manual verification covers start/stop and confirms no stale PID/status artifacts remain after graceful shutdown

## Dependencies
None.

## Blockers
- Need confirmation if existing runtime lifecycle code has hidden ownership assumptions that conflict with centralized PID/status artifact management.
