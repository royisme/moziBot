# Runtime Host Deep Dive (`src/runtime/host/`)

## Scope

This document describes the host-layer orchestration surface under `src/runtime/host/`.

Host layer responsibilities:

- process lifecycle and runtime startup/shutdown
- message routing and command handling
- session-key resolution and session state hydration
- runtime status, heartbeat, cron, and health checks

Primary entrypoint in this layer:

- `src/runtime/host/index.ts` (`RuntimeHost`)

## Core Files and Responsibilities

- `index.ts`
  - boots config watcher/db/channels/kernel/session manager
  - initializes and reloads `MessageHandler`
  - runs sandbox bootstrap/probe lifecycle hooks
  - owns health-check loop and runtime status snapshot
- `main.ts`
  - runtime host executable entrypoint used by CLI runtime launch path
- `message-handler.ts`
  - command handling (`/help`, `/status`, `/models`, `/switch`, etc.)
  - multimodal ingest + provider payload building
  - prompt execution, fallback logic, output rendering
  - lifecycle-driven session rotation (`/new`, temporal, semantic)
- `router.ts`
  - resolves target agent by channel + dm/group routing config
- `session-key.ts`
  - deterministic session key generation based on agent/channel/peer/thread
- `sessions/*`
  - session persistence model and subagent session registration helpers
- `src/runtime/session-store.ts`
  - segmented session ledger (`latest` pointer + archived immutable segments)
- `heartbeat.ts`, `health.ts`, `cron/*`
  - host operational background loops

## Request Path in Host Layer

1. Channel adapter emits inbound message event.
2. `RuntimeHost` enqueues message through runtime kernel.
3. Kernel dispatches queue item to `MessageHandler.handle(...)`.
4. `MessageHandler`:
   - resolves route and session key
   - runs command branch or agent prompt branch
   - performs multimodal negotiation/fallback when media present
5. Outbound text/media is sent back through channel plugin.

## What to Edit (by task)

### A) Change command UX or slash-command semantics

- Edit:
  - `src/runtime/host/message-handler.ts`
- Also inspect:
  - `src/runtime/host/reply-utils.ts`
  - channel plugins for edit/typing support

### B) Change agent routing policy (group/dm behavior)

- Edit:
  - `src/runtime/host/router.ts`
- Also inspect:
  - `src/runtime/host/session-key.ts`
  - config schema for channel routing fields

### C) Change session partitioning behavior

- Edit:
  - `src/runtime/host/session-key.ts`
- Also inspect:
  - `src/runtime/session-store.ts`
  - `src/runtime/host/sessions/manager.ts`
  - `src/runtime/host/message-handler.ts` (temporal/semantic rollover triggers)

### D) Change runtime lifecycle behavior

- Edit:
  - `src/runtime/host/index.ts`
  - `src/runtime/host/main.ts`
- Also inspect:
  - `src/cli/runtime.ts`
  - `src/runtime/host/lifecycle.ts`

## Verification

- Baseline:
  - `pnpm run test`
  - `pnpm run check`
- High-signal focused tests:
  - `src/runtime/host/message-handler*.test.ts`
  - `src/runtime/host/sessions/*.test.ts`
  - channel adapter tests if host output behavior changed

## Detached Run Observability Runbook (P3-T4)

### Canonical Fields

Use these fields as the single correlation keyset across host/core logs:

- `runId`: detached run identity (e.g. `run:m-1`)
- `sessionKey`: session partition key
- `traceId`: turn trace identity (e.g. `turn:m-1`)
- `terminal`: `completed | failed | aborted`
- `reason`: terminal reason / abort reason / failure summary
- `errorCode`: normalized runtime error code when available

### Where These Fields Are Emitted

1. Detached terminal projection in host:
   - `src/runtime/host/message-handler.ts`
   - log message: `Detached run terminal observed`
2. Terminal reply projection in execution path:
   - `src/runtime/host/message-handler/flow/execution-flow.ts`
   - log message: `Terminal reply delivered`
3. Queue detached run acceptance + terminal handling:
   - `src/runtime/core/kernel/queue-item-processor.ts`
   - log messages: `Queue item detached run accepted`, `Queue item interrupted while processing`, error/retry/failure logs

### Fast Trace Procedure (single run)

1. Find `runId` from `Queue item detached run accepted`.
2. Use `runId` + `traceId` to locate `Detached run terminal observed`.
3. For success path, verify `Terminal reply delivered` with matching `traceId` and expected `deliveryMode`.
4. For failed/aborted path, verify queue terminal handling logs include aligned `reason`/`errorCode` and final session status transition.

### Symptom → Check

- Symptom: duplicate terminal effects
  - Check `Detached run terminal observed` count per `runId` (should be one terminal projection)
  - Validate lifecycle uniqueness tests:
    - `src/runtime/host/message-handler/services/run-lifecycle-registry.test.ts`
    - `src/runtime/host/message-handler.detached-run.test.ts`

- Symptom: streamed text and final reply mismatch
  - Check `Terminal reply decision` + `Terminal reply delivered`
  - Compare `terminalSource`, `terminalChars`, `deliveryMode`

- Symptom: queue item stuck or wrong final status
  - Check `Queue item detached run accepted` exists first
  - Then inspect terminal handling logs in queue processor by `queueItemId/sessionKey/runId`

### High-Signal Validation Commands

- `pnpm run test -- src/runtime/host/message-handler.detached-run.test.ts`
- `pnpm run test -- src/runtime/host/message-handler/services/run-lifecycle-registry.test.ts`
- `pnpm run test -- src/runtime/host/message-handler/flow/execution-flow.test.ts`
- `pnpm run test -- src/runtime/host/message-handler/services/run-dispatch.test.ts`

## Host-Layer Constraints

- Keep command text, routing, and session-key behavior internally consistent.
- Avoid bypassing router/session-key helpers when adding new host pathways.
- Any lifecycle change must preserve clean shutdown semantics (channel disconnect, heartbeat/cron stop, kernel stop).
