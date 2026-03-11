# Task 04 — Validate and Resolve

## Status
planned

## Objective
Run project validation, confirm the runtime behavior change, and mark the detached-subagent prompt/timeout fix complete.

## Inputs / Prerequisites
- `devDocs/spec/detached-subagent-prompt-timeout.md`
- `devDocs/spec/detached-subagent-prompt-timeout-impl.md`
- implementation and regression-test changes from Tasks 01–03

## Validation Steps
- `pnpm run check`
- `pnpm run test`
- optional `npx tsc --noEmit` if additional type verification is needed

## Behavior Validation Focus
- Omitted-`agentId` detached runs no longer default to full/main prompt mode.
- Detached minimal prompt mode no longer loads identity/persona files unless config explicitly asks for full.
- Detached runs without explicit `timeoutSeconds` receive the outer default timeout.

## Deliverables
- Validation evidence from project checks
- Resolved task files after successful verification

## Dependencies
- task-01-fix-prompt-mode.md
- task-02-add-default-detached-timeout.md
- task-03-add-regression-tests.md
