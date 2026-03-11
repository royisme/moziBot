# Task 01 — Fix Detached Subagent Prompt Mode Resolution

## Status
planned

## Objective
Ensure detached subagent spawning resolves prompt mode from the parent agent configuration even when `agentId` is omitted.

## Inputs / Prerequisites
- `devDocs/spec/detached-subagent-prompt-timeout.md`
- `devDocs/spec/detached-subagent-prompt-timeout-impl.md`
- `src/runtime/subagent-registry.ts`
- `src/runtime/agent-manager.ts`
- `src/runtime/agent-manager/config-resolver.ts`
- `src/runtime/agent-manager/prompt-builder.ts`

## Implementation Notes
- Remove the detached-path branch that hardcodes omitted-`agentId` runs to `full`.
- Always resolve prompt mode through `resolveSubagentPromptMode(parentAgentId)`.
- Preserve existing mapping from config values to prompt-builder modes.
- Keep `agentId` optional; do not change API shape.

## Deliverables
- Updated `src/runtime/subagent-registry.ts`

## Validation Expectations
- Omitted-`agentId` detached runs no longer force `main`.
- Resolved `minimal` continues to map to `subagent-minimal`.

## Dependencies
None.
