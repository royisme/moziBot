# Task 05 — Add Recovery and Regression Validation

## Status
planned

## Objective
Ensure restart, recovery, replay, and final validation semantics are implemented and covered by regression tests.

## Inputs / Prerequisites
- `devDocs/spec/async-task-lifecycle.md`
- `devDocs/spec/async-task-lifecycle-impl.md`
- lifecycle registry and delivery behavior from Tasks 02–04

## Expected Code Targets
- `src/runtime/host/sessions/subagent-registry.ts`
- host bootstrap/startup reconciliation paths
- targeted test suites in runtime host/session areas

## Implementation Notes
- Replay pending terminal notices on restart.
- Detect and reconcile orphaned in-progress runs after host restart.
- Preserve dedupe markers and delivery evidence across serialization boundaries.
- Validate that no accepted user-visible task reaches terminal state without send evidence or queued retry evidence.
- Close the loop with explicit validation commands and runtime observation expectations.

## Validation Expectations
- Restart replay tests for pending terminal notices.
- Orphaned in-progress run handling tests.
- Regression tests covering acceptance visibility, terminal delivery, summarize `NO_REPLY`, and parent-turn guard behavior.
- Final successful runs of `pnpm run check` and `pnpm run test`.

## Dependencies
- task-02-build-authoritative-task-registry.md
- task-03-add-guaranteed-user-delivery.md
- task-04-wire-parent-turn-and-prompt-rules.md

## Blockers
- Any startup/bootstrap path that cannot currently replay persisted undelivered lifecycle notices.
