# Subagent Management Menu Specification

## Overview
The runtime already persists detached subagent runs and tracks active prompt execution in memory, but users still lack a direct control surface for inspecting and stopping detached work after it leaves the main turn. When a detached or subagent run becomes unresponsive, the system can enter a black-hole state where the run still appears active yet the user has no practical way to inspect, stop, or reconcile it from Telegram or Discord.

This change adds a minimal but reliable `/tasks` control surface for detached subagent management. The control surface reuses the existing inline-button interaction style used by `/models`, bridges the persistent detached run registry with the in-memory run lifecycle registry, and provides a minimum operational loop: list, status, stop, and reconcile.

## Problem Statement
- Users can trigger detached or subagent work, but they cannot inspect or control those runs through the existing chat UI.
- Detached run state is split across two sources:
  - persistent detached registry: `src/runtime/host/sessions/subagent-registry.ts`
  - in-memory lifecycle registry: `src/runtime/host/message-handler/services/run-lifecycle-registry.ts`
- If a run still exists in persistent state but no longer has a live lifecycle handle, users currently have no direct recovery path.
- Existing `/stop` only targets the active top-level session run, not detached child runs.

## Goals
- Add a `/tasks` command family with Telegram/Discord button menus.
- Reuse the `/models` interaction pattern and current callback/custom_id routing.
- Introduce a thin control-plane service that bridges persistent and runtime run state without redesigning either registry.
- Support list, detail, stop, and manual reconcile operations.
- Give orphaned or stale runs a reliable terminalization path.
- Add focused automated coverage for menu behavior, control-plane behavior, and orphan reconciliation.

## Scope
- New command service: `src/runtime/host/message-handler/services/tasks-command.ts`
- New control plane: `src/runtime/host/message-handler/services/tasks-control-plane.ts`
- Detached run registry extensions in `src/runtime/host/sessions/subagent-registry.ts`
- Command wiring updates in message-handler command registry/builder files
- Agent tool addition for `subagent_stop`
- Tests for command behavior and control-plane behavior
- Non-trivial spec/task docs under `devDocs/spec/subagent-management-menu*`

## Non-goals
- No force-kill or provider-level hard stop.
- No redesign of detached run lifecycle ownership.
- No pagination, bulk operations, or advanced filtering.
- No new transport-specific callback protocol.
- No replacement of `/stop` for the top-level interactive session.

## Required Behavior
### `/tasks`
- Lists detached/subagent runs for the current parent session.
- When button-capable channels are available, render inline buttons for status, stop, refresh, and reconcile.
- When buttons are not available, return usable text output.

### `/tasks status <runId>`
- Returns detailed status for a run scoped to the current parent session.
- Includes a return-to-list button when buttons are supported.

### `/tasks stop <runId>`
- Verifies that the run belongs to the current parent session.
- If the run still has a live lifecycle entry, stop it through cooperative abort.
- If the run only exists in persistent state, converge it to terminal `aborted` state with explicit stop reason.
- If already terminal, return an idempotent response.

### `/tasks reconcile`
- Triggers detached-run reconciliation.
- Explicitly converges persistent non-terminal runs that no longer have a live runtime handle.
- Returns a summary of what was reconciled.

## Data Requirements
Detached run records should minimally support extra observability/stop metadata:
- `abortRequestedAt?`
- `abortRequestedBy?`
- `staleDetectedAt?`

These fields are diagnostic and must not require a state-machine redesign.

## Authorization and Safety
- Operations must be limited to runs whose `parentKey` matches the current session.
- Cross-parent access must be rejected.
- Stopping a terminal run must be safe and idempotent.
- Fallback terminalization is allowed only for orphaned or persistent-only runs.

## Acceptance Criteria
1. `/tasks` shows current runs for the parent session and can render button menus.
2. `/tasks status <runId>` shows detail and supports return navigation.
3. `/tasks stop <runId>` aborts live runs cooperatively.
4. Persistent-only orphaned runs can be converged via stop or reconcile.
5. Cross-parent operations are rejected.
6. Agent-facing `subagent_stop` uses the same shared control-plane semantics.
7. Validation includes `pnpm run check` and `pnpm run test`.
