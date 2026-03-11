# Detached Subagent Prompt Mode and Timeout Specification

## Overview
Detached subagent runs currently have two stacked default-behavior bugs. First, when `subagent_run` omits `agentId`, the detached path treats the run as if it should use the full main prompt instead of resolving the parent's configured subagent prompt mode. Second, detached runs do not enforce an explicit outer timeout by default, so they can sit in a long-running accepted state and appear hung even though the inner prompt runner still has its own timeout.

This change restores the intended detached-subagent defaults: self-derived detached runs must still honor subagent prompt-mode policy, and every detached run must have a bounded outer timeout.

## Problem Statement
- Detached `subagent_run` allows `agentId` to be omitted to mean “spawn as myself”.
- `src/runtime/subagent-registry.ts` currently branches on `params.agentId` presence and hardcodes omitted-`agentId` detached runs to prompt mode `full`, which maps to prompt builder mode `main`.
- That behavior loads full identity/persona files (`SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, `HEARTBEAT.md`) even when the parent agent is configured for minimal subagent prompts.
- Detached runs also pass through without a default outer `timeoutSeconds`, which means the run can remain visibly active for too long before any terminal state is persisted.

## Goals
- Make detached subagent prompt-mode resolution consistent whether `agentId` is explicit or omitted.
- Preserve the current API shape where omitted `agentId` means “derive a detached run from the parent agent itself”.
- Ensure detached runs always get an explicit outer timeout.
- Add regression coverage for prompt-mode resolution and timeout-default precedence.
- Document the bug, scope, and validation path as a non-trivial fix.

## Scope
- `src/runtime/subagent-registry.ts`
- Regression tests in detached/subagent runtime suites
- Non-trivial spec and task docs under `devDocs/spec/`

## Non-goals
- Redesigning the `subagent_run` API.
- Adding a new config schema field such as `detachedTimeoutSeconds`.
- Changing existing prompt builder semantics for `main` or `subagent-minimal`.
- Expanding this fix into broader async lifecycle or detached-run UX work.

## Required Behavior
### Prompt mode
- Detached `spawn()` must always resolve subagent prompt mode via `AgentManager.resolveSubagentPromptMode(parentAgentId)`.
- Resolved config value `full` must map to prompt builder mode `main`.
- Resolved config value `minimal` must map to prompt builder mode `subagent-minimal`.
- This rule must apply even when `agentId` is omitted and the detached run targets the parent agent itself.

### Timeout
- Detached `spawn()` must always pass an explicit outer timeout to `startDetachedPromptRun(...)`.
- Timeout precedence must be:
  1. timeout already stored in detached run registry
  2. explicit `params.timeoutSeconds`
  3. local runtime default of `300` seconds

## Acceptance Criteria
1. Omitted-`agentId` detached runs no longer hardcode full/main prompt mode.
2. Parent agents configured for minimal subagent prompts produce detached runs with `promptMode: "subagent-minimal"`, regardless of whether `agentId` was explicit.
3. Detached runs without explicit timeout now pass `300` seconds to the outer detached prompt runtime.
4. Explicit caller timeout still overrides the default.
5. Regression tests fail on the old behavior and pass with the new behavior.
6. Validation includes `pnpm run check` and `pnpm run test`.

## Validation Expectations
- Confirm omitted-`agentId` detached runs use parent prompt-mode resolution instead of `full` fallback.
- Confirm detached timeout defaulting and precedence.
- Confirm no API or schema change is introduced as part of this bug fix.
