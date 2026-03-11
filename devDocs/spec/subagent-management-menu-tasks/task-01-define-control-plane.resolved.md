# Task 01 - Define control plane

## Goal
Add a thin service that bridges persistent detached run state and in-memory lifecycle state.

## Requirements
- Create `tasks-control-plane.ts`
- Support list/detail/stop/reconcile
- Enforce parent-session ownership checks
- Prefer cooperative abort and fall back to terminalization for orphaned runs

## Validation
- Add focused unit tests for live, orphaned, and terminal runs
