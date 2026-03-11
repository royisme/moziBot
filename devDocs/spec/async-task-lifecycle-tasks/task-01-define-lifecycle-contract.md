# Task 01 — Define Lifecycle Contract

## Status
planned

## Objective
Write the async task lifecycle spec and implementation guide with explicit lifecycle phases, ownership rules, visibility policy, acknowledgement semantics, and terminal delivery guarantees.

## Inputs / Prerequisites
- `CLAUDE.md`
- `devDocs/agent-operating-model.md`
- existing runtime detached/subagent implementation
- OpenClaw reference findings
- `devDocs/spec/selfwork/unified-delivery-route-context.md`

## Implementation Notes
- Keep the spec focused on product/runtime behavior contract, not code structure.
- Keep the implementation guide focused on architecture, boundaries, persistence, and tradeoffs.
- Explicitly separate lifecycle truth, delivery guarantee, and optional conversational summarization.
- Define anti-black-hole guarantees in concrete terms.
- Ensure parent-turn responsibility remains explicit after detached acceptance.

## Deliverables
- `devDocs/spec/async-task-lifecycle.md`
- `devDocs/spec/async-task-lifecycle-impl.md`

## Validation Expectations
- Artifacts align with roles defined in `devDocs/agent-operating-model.md`.
- Canonical lifecycle and visibility guarantees are explicit and testable.
- Acceptance criteria are concrete enough to drive implementation and regression tests.

## Dependencies
None.

## Blockers
- Need confirmation of any runtime constraints discovered in existing detached-run files that would materially change lifecycle wording.
