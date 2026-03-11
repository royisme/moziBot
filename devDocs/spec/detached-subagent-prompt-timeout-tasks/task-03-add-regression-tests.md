# Task 03 — Add Regression Tests

## Status
planned

## Objective
Add regression tests covering detached prompt-mode resolution and detached timeout-default precedence.

## Inputs / Prerequisites
- `devDocs/spec/detached-subagent-prompt-timeout.md`
- `devDocs/spec/detached-subagent-prompt-timeout-impl.md`
- `src/runtime/subagent-registry.test.ts`
- optionally `src/runtime/host/message-handler.detached-run.test.ts`

## Implementation Notes
- Add a test proving omitted `agentId` still resolves prompt mode from the parent agent.
- Add a test proving resolved `minimal` maps to detached `subagent-minimal`.
- Add a test proving the detached default timeout is `300` seconds.
- Add a test proving explicit timeout overrides the default.
- Avoid duplicating timeout-terminal behavior already covered elsewhere.

## Deliverables
- Updated runtime regression tests

## Validation Expectations
- Tests fail against the prior hardcoded/full and no-default-timeout behavior.
- Tests pass with the fix in place.

## Dependencies
- task-01-fix-prompt-mode.md
- task-02-add-default-detached-timeout.md
