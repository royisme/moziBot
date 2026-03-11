# Task 03 - Add stop and reconcile

## Goal
Provide user and agent-facing stop/reconcile controls for detached runs.

## Requirements
- `/tasks stop <runId>` uses shared control plane
- `/tasks reconcile` triggers orphan/stale convergence
- Detached registry records stop/stale metadata
- Cross-parent access is rejected

## Validation
- Add tests for live abort, orphan terminalization, and reconcile summary
