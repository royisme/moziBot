# Task 02 — Add Default Detached Outer Timeout

## Status
planned

## Objective
Give detached subagent runs a consistent outer timeout default so accepted runs do not linger indefinitely without a terminal state.

## Inputs / Prerequisites
- `devDocs/spec/detached-subagent-prompt-timeout.md`
- `devDocs/spec/detached-subagent-prompt-timeout-impl.md`
- `src/runtime/subagent-registry.ts`
- detached run registry timeout behavior in `src/runtime/host/sessions/`

## Implementation Notes
- Add a local default constant of `300` seconds in the detached spawn path.
- Use timeout precedence:
  1. existing registry timeout
  2. explicit caller timeout
  3. default constant
- Do not add a new config field in this task.

## Deliverables
- Updated `src/runtime/subagent-registry.ts`

## Validation Expectations
- Detached runs always pass an explicit outer timeout.
- Explicit timeout remains higher priority than the default.

## Dependencies
- task-01-fix-prompt-mode.md
