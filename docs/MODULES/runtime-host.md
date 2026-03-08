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

## Subagent System (`sessions_spawn` / `subagent_run`)

The host layer manages detached background subagent execution through a set of coordinated components.

### Core Components

- `src/runtime/host/sessions/spawn.ts` - Spawns subagent sessions via `spawnSubAgent()`
- `src/runtime/host/sessions/subagent-registry.ts` - Tracks all subagent runs via `EnhancedSubAgentRegistry`
- `src/runtime/host/sessions/subagent-announce.ts` - Announces terminal results to parent session

### Detached/Background Execution

Subagents run as detached background tasks. When `sessions_spawn` (or `subagent_run`) is invoked:

1. A new child session is created with channel `"subagent"` and `parentKey` set to the spawning session
2. The run is registered in `EnhancedSubAgentRegistry` with status `"accepted"`
3. The run executes asynchronously in a separate session context
4. Parent receives immediate response (not waiting for completion)

### Immediate Accepted Response

`sessions_spawn` returns immediately with a `SpawnResult`:
```typescript
{ runId: string; childKey: string; sessionId: string; status: "accepted" | "rejected" | "error"; error?: string }
```

- `"accepted"`: Subagent started successfully
- `"rejected"`: Spawn denied (nested subagent, missing parent, etc.)
- `"error"`: Internal error during spawn

### Status/List Querying

Two tools provide querying capabilities:

- `subagent_status` / `sessionsStatus` - Query specific runs or list runs by parent
  - `runId`: Check specific run
  - `parentKey`: List all runs spawned by a session
  - No args: List all tracked runs

- `subagent_list` - Alias for `subagent_status`

Return format includes: `runId`, `label`, `status`, `runtime` (duration), `error`

### timeoutSeconds Behavior

- Optional parameter in `sessions_spawn` (`runTimeoutSeconds`)
- Set at spawn time and stored in registry
- When timeout expires, run transitions to `"timeout"` terminal state
- Timeout triggers announcement to parent session

### Terminal States

`SubAgentRunStatus` values:
- `"accepted"` - Spawned, waiting to start
- `"started"` - Execution began
- `"streaming"` - Actively producing output
- `"completed"` - Finished successfully
- `"failed"` - Execution failed with error
- `"aborted"` - Cancelled by user/system
- `"timeout"` - Exceeded timeout threshold

Terminal states: `"completed"`, `"failed"`, `"aborted"`, `"timeout"`

### Parent Announcement Behavior

On terminal transition:
1. `EnhancedSubAgentRegistry.setTerminal()` is called
2. `triggerAnnounce()` checks if announcement needed
3. Builds trigger message via `buildTriggerMessage()`
4. Injects message into parent session via `messageHandlerRef.handleInternalMessage()`
5. Message includes metadata: `subagentRunId`, `subagentChildKey`, `subagentStatus`
6. Announced runs are marked `announced: true`

Announcement content includes:
- Task label or truncated task description
- Status (completed/failed/timeout)
- Result or error message
- Runtime duration
- Natural-language summarization prompt (with `NO_REPLY` option)

### Restart Reconciliation

On host startup/restart:
1. `EnhancedSubAgentRegistry.restore()` loads persisted runs from `subagent-runs.json`
2. `reconcileOrphanedRuns()` identifies non-terminal runs (`accepted`/`started`/`streaming`)
3. Orphaned runs are marked as `"failed"` with error: "Host restarted while run was in progress"
4. This triggers announcement to parent session about the interrupted run

Cleanup policy (`cleanup` field):
- `"delete"`: Remove run record after announcement
- `"keep"`: Retain run record for history

### Tool Definitions

- `sessions_spawn` schema:
  ```typescript
  {
    task: string;
    agentId?: string;
    model?: string;
    label?: string;
    cleanup?: "delete" | "keep";
    runTimeoutSeconds?: number;
    runtime?: "default" | "acp";
    acp?: { backend?: string; agent?: string; mode?: "persistent" | "oneshot"; ... };
  }
  ```

- `sessions_list` schema:
  ```typescript
  {
    agentId?: string;
    channel?: string;
    status?: "idle" | "queued" | "running" | "retrying" | "completed" | "failed" | "interrupted";
    limit?: number;
  }
  ```

### Persistence

- Subagent runs persisted to: `{dataDir}/subagent-runs.json`
- Sweeper runs every 5 minutes, cleaning up announced runs older than 1 hour
- Registry shutdown ensures final persistence
