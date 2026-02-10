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

## Host-Layer Constraints

- Keep command text, routing, and session-key behavior internally consistent.
- Avoid bypassing router/session-key helpers when adding new host pathways.
- Any lifecycle change must preserve clean shutdown semantics (channel disconnect, heartbeat/cron stop, kernel stop).
