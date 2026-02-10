# Runtime Core Deep Dive (`src/runtime/core/`)

## Scope

This document focuses on queue and execution core behavior under `src/runtime/core/`.

Core objective:

- convert inbound envelopes into queue items
- apply queue mode policy (`followup`, `collect`, `interrupt`, `steer`, `steer-backlog`)
- drive dispatch and retries with explicit error policy

Primary file:

- `src/runtime/core/kernel.ts` (`RuntimeKernel`)

## Key Files

- `kernel.ts`
  - enqueue logic + dedup
  - per-session active processing control
  - pump loop and poll timer
  - queue-mode-specific injection/interrupt behavior
- `contracts.ts`
  - canonical runtime queue contracts (`RuntimeQueueConfig`, statuses, egress interfaces)
- `error-policy.ts`
  - transient vs capability error decisions + exponential backoff
- `egress.ts`
  - runtime egress bridge to channel registry
- `continuation.ts`
  - continuation registry and scheduling hooks

## Queue Modes (Operational Meaning)

- `followup`
  - append work to queue in normal session flow
- `collect`
  - collect window behavior for batching-like handling
- `interrupt`
  - interrupt existing running/retrying session queue items
- `steer`
  - attempt direct in-session steering instead of queueing when possible
- `steer-backlog`
  - steer active sessions, otherwise enqueue backlog

Use `RuntimeQueueConfig` in `contracts.ts` + runtime config wiring to tune behavior.

## Error and Retry Semantics

Default error policy (`error-policy.ts`):

- capability errors: terminal (no retry)
- transient errors: retry with exponential backoff
- terminal fallback after retry limit

If you change retry behavior, update policy and verify queue status transitions in db.

## What to Edit

### A) Change queue transition behavior

- Edit:
  - `kernel.ts`
- Also inspect:
  - `src/storage/db.ts` (`runtimeQueue` APIs)
  - `src/runtime/host/message-handler.ts`

### B) Change retry policy

- Edit:
  - `error-policy.ts`
- Also inspect:
  - queue status updates in kernel
  - user-visible failure paths in host layer

### C) Add new queue mode

- Edit:
  - `contracts.ts` (`RuntimeQueueMode`)
  - `kernel.ts` mode branching
  - runtime config schema docs/tests

## Verification

- Baseline:
  - `pnpm run test`
  - `pnpm run check`
- Focus:
  - `src/runtime/core/*.test.ts`
  - queue integration tests referencing runtime queue tables

## Constraints

- Queue and db status transitions must remain reversible/inspectable after restart recovery.
- Avoid mode behavior that can create hidden starvation or unbounded retry loops.
