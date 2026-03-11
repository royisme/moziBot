# Task 02 — Build Authoritative Task Registry

## Status
planned

## Objective
Refactor the current detached-run registry into the authoritative owner of async lifecycle state and delivery bookkeeping for spawned, detached, and subagent tasks.

## Inputs / Prerequisites
- `devDocs/spec/async-task-lifecycle.md`
- `devDocs/spec/async-task-lifecycle-impl.md`
- existing detached-run registry behavior in `src/runtime/host/sessions/subagent-registry.ts`

## Expected Code Targets
- `src/runtime/host/sessions/subagent-registry.ts`
- new lifecycle module(s) under `src/runtime/host/sessions/`

## Implementation Notes
- Introduce a clear async task record model with lifecycle phase and delivery-state fields.
- Move phase transition ownership into the authoritative registry.
- Add serialization and restore support for lifecycle and delivery metadata.
- Record dedupe markers and terminal bookkeeping in the registry rather than scattered call sites.
- Preserve compatibility long enough to migrate existing callers safely.

## Validation Expectations
- Unit tests for lifecycle state transitions.
- Unit tests for accepted/started/streaming/terminal dedupe behavior.
- Unit tests for persistence serialization and restore.
- Unit tests for terminal bookkeeping and replay readiness.

## Dependencies
- task-01-define-lifecycle-contract.md

## Blockers
- Any unresolved mismatch between current detached-run persistence model and required lifecycle metadata.
