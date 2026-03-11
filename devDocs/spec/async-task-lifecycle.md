# Async Task Lifecycle Specification

## Overview
moziBot currently allows spawned, detached, and subagent work to be accepted and even completed without a guaranteed user-visible acknowledgement or terminal result. The existing internal-message announce path is useful for conversational summaries, but it is not a delivery guarantee because both the parent turn and the injected announce turn can legally end with `NO_REPLY`.

This change defines a first-class async task lifecycle contract so detached work remains observable, trustworthy, and recoverable. The runtime must treat async acceptance and terminal delivery as managed responsibilities rather than incidental side effects of a spawn flow.

## Problem Statement
- User-originated async work can be accepted without a visible acknowledgement.
- Terminal completion, failure, timeout, or abort outcomes can be generated without guaranteed delivery back to the user.
- The current internal announce path can silently fail the visibility contract when summarization returns `NO_REPLY`, is skipped, or is lost across restart boundaries.
- The runtime lacks one authoritative lifecycle model covering ownership, delivery state, persistence, and recovery semantics.

## Why This Change Exists
- Async work must be observable and trustworthy from the user's perspective.
- Parent-session responsibility must continue after spawn; accepting detached work is a promise, not a best-effort hint.
- Delivery correctness must live at the runtime layer, not only inside optional conversational summarization.
- Restart and replay behavior must preserve visibility guarantees instead of creating black holes.

## Goals
- Define one canonical lifecycle for spawned, detached, subagent, and other user-visible async work.
- Guarantee visible acceptance semantics for user-originated async tasks.
- Guarantee direct or queued terminal delivery semantics for completion, failure, timeout, and abort states.
- Define persistence and recovery rules for in-flight work and undelivered terminal notices.
- Prevent accepted user-visible async work from disappearing without evidence.

## Scope
- User-visible lifecycle for spawned, detached, subagent, and background work that is intended to report back to the user.
- Acceptance acknowledgement semantics.
- Terminal completion, failure, timeout, and abort delivery semantics.
- Persistence and recovery for in-flight tasks and pending terminal notices.
- Anti-black-hole guarantees and delivery evidence requirements.
- Parent-turn responsibility rules when async work is accepted.

## Non-goals
- Redesigning every job system in one pass.
- Channel-specific UX polish beyond guaranteed delivery.
- Rewriting unrelated routing behavior except where required to preserve delivery context.
- Replacing optional LLM summarization with a purely system-generated UX everywhere.

## Canonical Lifecycle
The canonical async lifecycle is:

`accepted -> started -> streaming? -> completed | failed | timeout | aborted`

### Phase meanings
- `accepted`: the runtime has accepted responsibility for the task and knows whether the task is user-visible.
- `started`: the task has begun actual execution.
- `streaming?`: optional intermediate progress or partial-output phase; it is not required for every task.
- `completed`: execution finished successfully and produced a terminal result.
- `failed`: execution ended unsuccessfully due to runtime or task failure.
- `timeout`: execution ended because time budget or wait contract expired.
- `aborted`: execution ended intentionally or was invalidated by cancellation, shutdown, or reconciliation.

## User-visible Guarantees
### Acceptance visibility
- Any user-originated async task marked user-visible must produce visible acknowledgement or a runtime-reserved guaranteed acknowledgement path.
- A parent turn that accepts user-visible detached work must not silently end with `NO_REPLY`.
- Acceptance is not considered delivered unless there is concrete delivery evidence or durable queued-delivery evidence.

### Terminal visibility
- A terminal outcome (`completed`, `failed`, `timeout`, `aborted`) must be delivered directly to the user or queued for retry/replay.
- A task must not be marked terminal-delivered based solely on an internal summarize attempt.
- Conversational summaries may enrich terminal delivery, but they must not be the sole guarantee mechanism.

### Delivery evidence
- Lifecycle delivery state must record whether acceptance and terminal phases were sent, queued, retried, replayed, deduped, or still pending.
- No task should be considered fully delivered without concrete evidence of outbound send or durable retry scheduling.

## Visibility Policy
Each async task must have an explicit visibility policy at acceptance time.

Recommended policy classes:
- `user_visible`: the task owes the user an acknowledgement and terminal outcome.
- `internal_silent`: the task is operational/internal and does not owe user-visible delivery.
- `policy_derived`: visibility is derived from the originating context but must resolve to a concrete policy before acceptance is persisted.

A task may be silent only if the runtime explicitly records that policy. Silence must not happen accidentally via prompt behavior.

## Ownership Contract
- The parent turn owns the initial acceptance decision and must not relinquish user-visible responsibility without scheduling guaranteed acknowledgement.
- The authoritative async task registry owns lifecycle truth and delivery bookkeeping after acceptance.
- Delivery services own direct dispatch, retry scheduling, dedupe, and replay of pending lifecycle notices.
- Optional summarize/announce flows are secondary presentation layers and cannot redefine lifecycle truth.

## Failure Scenarios and Edge Cases
### Internal announce LLM returns `NO_REPLY`
- The task remains user-visible.
- Guaranteed runtime delivery must still occur or remain queued.
- `NO_REPLY` from summarize flow must not count as successful terminal delivery.

### Parent session unavailable
- The runtime must preserve origin delivery metadata and queue retry/replay rather than dropping the notice.

### Host restart during in-flight run
- In-flight tasks must be reconciled deterministically.
- Undelivered terminal notices must be replayed after restart.
- Runs that can no longer continue live must transition to a deterministic terminal state, typically `aborted` or `failed`, with explicit delivery handling.

### Duplicate announce attempts
- Lifecycle delivery must dedupe by task and phase.
- Retried delivery should not produce duplicate terminal claims unless the system cannot prove prior delivery and chooses safe-at-least-once semantics with explicit markers.

### Terminal result available but summarize path fails
- Direct runtime delivery remains required.
- Summarization failure may degrade presentation quality, but not delivery correctness.

### Ack reserved but send delayed
- The system may reserve a guaranteed acknowledgement path before the parent turn ends, but the reservation must be persisted and observable.
- Reserved acknowledgement without send evidence must remain pending until delivered or explicitly failed.

## Acceptance Criteria
1. No accepted user-visible task can disappear without either visible acknowledgement or an explicit recorded non-user-visible policy.
2. No terminal task can be marked delivered without concrete delivery evidence.
3. Parent turns that accept user-visible detached work cannot silently finish with `NO_REPLY` unless a guaranteed acknowledgement path is already reserved and persisted.
4. Internal summarize/announce flows are optional augmentation, not the sole delivery mechanism for acceptance or terminal phases.
5. The runtime persists enough metadata to recover in-flight tasks and pending terminal notices after restart.
6. Recovery logic replays pending terminal notices and deterministically reconciles orphaned in-progress tasks.
7. Delivery logic dedupes lifecycle phases so retries and restarts do not create uncontrolled duplicate notifications.
8. Validation can prove both the presence of delivery evidence and the absence of black-hole paths.

## Validation Expectations
- Lifecycle contract is expressed in concrete, testable runtime terms.
- User-visible guarantees are phrased independently from any one announce prompt implementation.
- Edge cases include silent summarize results, unavailable parent session, restart recovery, dedupe, and failed summarize paths.
- Acceptance criteria are specific enough to drive unit, integration, and recovery tests.

## Dependencies and Inputs
- `CLAUDE.md`
- `devDocs/agent-operating-model.md`
- existing detached/subagent runtime implementation
- relevant OpenClaw reference findings
- `devDocs/spec/selfwork/unified-delivery-route-context.md` for structure/style inspiration where applicable
