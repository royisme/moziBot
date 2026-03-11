# Task 03 — Add Guaranteed User Delivery

## Status
planned

## Objective
Add a direct runtime delivery path for accepted and terminal lifecycle events that does not rely solely on internal-message summarization.

## Inputs / Prerequisites
- `devDocs/spec/async-task-lifecycle.md`
- `devDocs/spec/async-task-lifecycle-impl.md`
- authoritative lifecycle registry changes from Task 02

## Expected Code Targets
- `src/runtime/host/sessions/subagent-announce.ts`
- `src/runtime/host/message-handler/services/reply-dispatcher.ts`
- new delivery module(s) under `src/runtime/host/sessions/`

## Implementation Notes
- Add guaranteed direct dispatch for acknowledgement and terminal notices.
- Layer summarize/announce generation on top of the guaranteed path instead of using it as the only path.
- Persist queued retry/replay state when direct send cannot complete immediately.
- Record concrete delivery evidence for each lifecycle phase.
- Add dedupe handling so retries and restarts do not create uncontrolled duplicate terminal notifications.

## Validation Expectations
- Integration tests proving user-visible acknowledgement still occurs when summarize flow yields `NO_REPLY`.
- Integration tests proving terminal delivery still occurs when summarize flow is skipped or fails.
- Delivery-state tests showing concrete evidence is recorded before a phase is considered delivered.

## Dependencies
- task-02-build-authoritative-task-registry.md

## Blockers
- Any dispatch-layer limitation that prevents direct lifecycle delivery from bypassing summarize injection.
