# Detached Subagent Prompt Mode and Timeout Implementation Guide

## Overview
This fix is intentionally narrow. The runtime bug is not that detached self-subagents are unsupported; the bug is that the omitted-`agentId` branch bypasses the configured subagent prompt-mode resolver and falls back to full/main prompt loading. A second bug is that detached runs do not consistently receive an explicit outer timeout, which delays terminalization and makes accepted work look stuck.

The implementation should therefore keep the current API shape, reuse existing prompt-mode resolution logic, and add a small runtime default for detached timeout handling.

## Root Causes
### 1. Prompt mode bypass
`SubagentRegistry.spawn()` currently distinguishes between explicit and omitted `agentId` for detached runs. In the omitted branch it assigns `"full"` directly instead of calling `AgentManager.resolveSubagentPromptMode(parentAgentId)`.

Result:
- detached self-subagent runs use prompt builder mode `main`
- identity/persona files are loaded even when the parent agent requested minimal subagent prompts
- detached behavior diverges from the synchronous `run()` path

### 2. Missing detached outer timeout default
The detached spawn path forwards `timeoutSeconds` from the registry entry only. When no timeout is recorded and the caller omits `timeoutSeconds`, the outer detached runtime runs without a bounded explicit timeout even though lower layers may still have their own defaults.

Result:
- terminal status is delayed
- detached runs remain visible as active for too long
- user-facing behavior looks hung or non-responsive

## Implementation Plan
### 1. Update detached prompt-mode resolution
File:
- `src/runtime/subagent-registry.ts`

Change:
- Remove the `params.agentId ? ... : "full"` branch in `spawn()`.
- Always call `this.agentManager.resolveSubagentPromptMode(params.parentAgentId)`.
- Continue mapping:
  - `full -> main`
  - `minimal -> subagent-minimal`

Rationale:
- reuses existing policy source of truth
- keeps omitted `agentId` semantics intact
- aligns detached behavior with the existing non-detached subagent path

### 2. Add detached timeout default
File:
- `src/runtime/subagent-registry.ts`

Change:
- Add a local constant:
  - `DEFAULT_DETACHED_SUBAGENT_TIMEOUT_SECONDS = 300`
- Compute detached timeout with precedence:
  1. `this.hostRuntime.detachedRunRegistry.get(detachedRunId)?.timeoutSeconds`
  2. `params.timeoutSeconds`
  3. `DEFAULT_DETACHED_SUBAGENT_TIMEOUT_SECONDS`

Rationale:
- minimal bug fix
- no schema change
- preserves explicit caller override
- guarantees bounded outer detached execution

## Test Strategy
Primary file:
- `src/runtime/subagent-registry.test.ts`

Add coverage for:
- omitted `agentId` still uses resolved subagent prompt mode
- resolved `minimal` maps to `subagent-minimal` in detached path
- default detached timeout of `300` is applied when no timeout is provided
- explicit timeout value wins over the default

Secondary file:
- `src/runtime/host/message-handler.detached-run.test.ts`

Only add coverage here if needed for a missing detached runtime contract. Avoid duplicating behavior already asserted at `SubagentRegistry.spawn()` call boundaries.

## Tradeoffs
### Why not require `agentId`?
Because omitted `agentId` is a useful and valid “spawn as myself” API shape. The fix should correct policy resolution, not remove the feature.

### Why not add a config field now?
Because this is a bug fix, not a configuration redesign. Introducing a new detached-timeout config would expand scope into schema, migration, and additional tests.

### Why use a local constant?
Because the default only needs to guarantee sane detached behavior right now. If future product requirements need per-agent detached timeout tuning, that can be added separately.

## Validation
Required commands:
- `pnpm run check`
- `pnpm run test`
- `npx tsc --noEmit` only if needed to verify type-checking independently of the existing scripts

Behavioral validation focus:
- detached self-subagent path no longer forces `main` prompt mode
- minimal prompt config remains minimal in detached mode
- detached runs now terminate under an explicit outer timeout budget by default
