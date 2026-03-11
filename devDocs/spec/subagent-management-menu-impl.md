# Subagent Management Menu Implementation Guide

## Overview
This feature should stay intentionally small. The runtime already has the pieces needed for detached task control, but they are split across two registries with no user-facing bridge. The implementation should add the thinnest possible control plane, reuse existing command/menu patterns, and avoid taking ownership away from the existing registries.

## Existing Building Blocks
- Menu interaction pattern: `src/runtime/host/message-handler/services/models-command.ts`
- Command wiring: `src/runtime/host/message-handler/services/command-registry.ts`, `command-map.ts`, `command-map-builder.ts`
- Persistent detached runs: `src/runtime/host/sessions/subagent-registry.ts`
- Live prompt lifecycle: `src/runtime/host/message-handler/services/run-lifecycle-registry.ts`
- Existing agent-facing run inspection: `src/agents/tools/sessions.ts`, `src/agents/tools/sessions-status.ts`

## Design
### 1. Thin control plane
Add `src/runtime/host/message-handler/services/tasks-control-plane.ts`.

Responsibilities:
- `listForParent(parentKey)` returns runs scoped to a parent session.
- `getDetail(runId, parentKey)` validates ownership and returns merged detail.
- `stop(runId, parentKey, requestedBy)`:
  - prefers `RunLifecycleRegistry.abortRun(...)` for live runs
  - falls back to detached registry terminalization for persistent-only orphaned runs
- `reconcile(parentKey?)` uses detached registry reconciliation with runtime-awareness.

Non-responsibilities:
- does not replace either registry
- does not become a new source of truth
- does not hard-kill underlying provider processes

### 2. `/tasks` command service
Add `src/runtime/host/message-handler/services/tasks-command.ts`.

Responsibilities:
- parse `/tasks`, `/tasks status <runId>`, `/tasks stop <runId>`, `/tasks reconcile`
- render button menus when channel send supports `buttons`
- degrade to plain text otherwise
- follow the same interaction pattern as `/models`

Suggested button layout:
- list rows: `Status <id>`, `Stop <id>`
- footer row: `Refresh`, `Reconcile`
- detail row: `Back`, optional `Stop`

### 3. Stop semantics
Use two-stage stop behavior.

#### Cooperative abort first
If a live lifecycle entry exists for the run:
- call `runLifecycleRegistry.abortRun(runId, reason)`
- preserve existing terminal callback flow
- mark detached registry stop request metadata before abort

#### Fallback terminalization second
If no live lifecycle entry exists but the persistent run is still non-terminal:
- treat it as orphaned or stale control state
- mark stale/abort metadata
- transition persistent record to `aborted`
- use an explicit reason such as `Stopped by user (orphaned run)`

### 4. Detached registry enhancements
Extend `DetachedRunRecord` with:
- `abortRequestedAt?`
- `abortRequestedBy?`
- `staleDetectedAt?`

Add reconciliation support that accepts an optional runtime liveness predicate so the registry can distinguish:
- host-restart recovery for all orphaned non-terminal runs
- active-process orphan detection where persistent state remains non-terminal but runtime control handle is missing

### 5. Shared semantics for agent tools
Add `subagent_stop` by reusing the same control-plane stop path used by `/tasks stop`.
Do not duplicate stop business logic in the tool layer.

## Wiring Plan
1. Add control-plane and tasks command service.
2. Extend command registry/map/help text for `/tasks`.
3. Inject detached registry and run lifecycle registry into command-map-builder.
4. Wire session tools context to include lifecycle/control-plane access.
5. Add `subagent_stop` tool.
6. Add focused tests.

## Testing Strategy
### Command layer
- `/tasks` with no runs
- `/tasks` with runs and buttons
- `/tasks status <runId>` detail rendering
- `/tasks stop <runId>` refreshes list or emits stop result
- invalid or cross-parent run access is rejected

### Control-plane layer
- live run -> abort path
- persistent-only run -> fallback terminalization
- terminal run -> idempotent result
- list/detail reflect both persistent and runtime state

### Reconcile layer
- non-terminal persistent run without live runtime handle becomes terminal
- stale metadata is recorded
- reconcile summary reflects changed runs

## Validation
Required:
- `pnpm run check`
- `pnpm run test`

Optional only if needed:
- `npx tsc --noEmit`
