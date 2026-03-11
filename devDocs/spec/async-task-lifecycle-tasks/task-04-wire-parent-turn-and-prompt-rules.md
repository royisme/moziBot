# Task 04 — Wire Parent Turn and Prompt Rules

## Status
planned

## Objective
Enforce lifecycle semantics in spawn, execution flow, and prompt handling so accepted user-visible async work cannot end the parent turn silently.

## Inputs / Prerequisites
- `devDocs/spec/async-task-lifecycle.md`
- `devDocs/spec/async-task-lifecycle-impl.md`
- guaranteed lifecycle delivery support from Task 03

## Expected Code Targets
- `src/runtime/host/sessions/spawn.ts`
- `src/runtime/subagent-registry.ts`
- `src/runtime/host/message-handler/flow/execution-flow.ts`
- `src/runtime/agent-manager/prompt-builder.ts`
- `src/runtime/host/reply-utils.ts`

## Implementation Notes
- Surface whether accepted detached work is user-visible and whether acknowledgement is already satisfied or reserved.
- Add parent-turn suppression guards so `NO_REPLY` cannot black-hole accepted user-visible async work.
- Keep prompt-level `NO_REPLY` available for truly silent/internal cases only.
- Make runtime guardrails authoritative when prompt silence conflicts with lifecycle guarantees.
- Ensure inbound user message -> spawn -> visible acknowledgement is enforced end to end.

## Validation Expectations
- Regression tests for accepted spawn plus parent `NO_REPLY` suppression guard.
- Integration coverage from inbound user message through spawn to visible acknowledgement.
- Tests showing silent/internal policies still remain possible when explicitly marked non-user-visible.

## Dependencies
- task-03-add-guaranteed-user-delivery.md

## Blockers
- Any unresolved ambiguity about where final parent-turn suppression is decided in execution flow.
