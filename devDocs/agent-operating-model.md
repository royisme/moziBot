# Agent Operating Model

This document defines how agent-assisted engineering work is structured in this repository.

The goal is not to maximize agent freedom.
The goal is to maximize reliable throughput, clear reasoning boundaries, and durable project knowledge.

## 1. Core Idea

Agents should not rely on hidden context, memory, or ad hoc chat history as the main source of truth.

Instead, work should be grounded in:
- versioned repository files
- explicit task artifacts
- explicit validation evidence
- explicit review outcomes

This repository treats agent work as an engineering system, not just a prompt-response interaction.

## 2. Design Principles

### 2.1 Docs are operational infrastructure
Documentation is not decoration.
For non-trivial work, devDocs are part of execution.

### 2.2 Plans before complexity
Small trivial changes can be done directly.
Non-trivial changes should be planned before implementation.

### 2.3 Validation before resolution
A task is not complete when code is written.
A task is complete when the intended change is validated to the required level.

### 2.4 Repo knowledge beats chat knowledge
If something matters beyond the current session, it should exist in the repo.

### 2.5 Repeated mistakes must become system rules
If the same issue happens again and again, the process is incomplete.

## 3. Knowledge Layers

This repo separates knowledge by layer.

### 3.1 Entry layer
`AGENTS.md`

Purpose:
- quick entrypoint
- task classification
- routing defaults
- minimum execution rules

Should remain short and operational.
It should not become a giant handbook.

### 3.2 Feature knowledge layer
`devDocs/spec/`

Purpose:
- define feature scope
- explain intent and constraints
- capture implementation guidance
- track feature-specific tasks

This is the main source of truth for non-trivial feature work.

### 3.3 Operational knowledge layer
`devDocs/troubleshooting.md`

Purpose:
- recurring failures
- root causes
- reliable fixes
- debugging shortcuts
- environment-specific gotchas

This is where debugging experience becomes reusable project knowledge.

### 3.4 Process knowledge layer
`devDocs/agent-operating-model.md`

Purpose:
- define the workflow model
- define artifact meanings
- define state transitions
- define validation and review expectations

### 3.5 Runtime execution layer
Examples:
- temporary task state files
- orchestration state
- transient review notes
- in-progress execution records

These are execution artifacts, not long-term truth by default.

If runtime artifacts contain durable conclusions, they should be promoted into devDocs.

## 4. Task Categories

## 4.1 Trivial work

Typical properties:
- small scope
- 1–2 files
- no architectural impact
- no new interface or schema
- easy to validate locally
- low risk and reversible

Expected process:
- implement directly
- run minimum validation
- summarize outcome

A trivial task does not require full spec/task scaffolding.

## 4.2 Non-trivial work

Typical properties:
- multiple files or modules
- design implications
- state flow or data model changes
- explicit tradeoffs
- staged execution needed
- review likely needed
- ambiguity likely without written artifacts

Expected process:
- clarify
- plan
- create artifacts
- implement in steps
- review
- validate
- resolve

Non-trivial work should leave a paper trail in the repo.

## 5. Artifact Hierarchy

For non-trivial work, artifacts should be created with clear roles.

### 5.1 Spec
Path:
- `devDocs/spec/<feature>.md`

Purpose:
- define what is being built or changed
- explain why
- define scope and exclusions
- capture constraints and acceptance expectations

Questions a spec should answer:
- What problem is being solved?
- Why does this change exist?
- What is in scope?
- What is out of scope?
- What constraints matter?
- What does successful behavior look like?

### 5.2 Implementation guide
Path:
- `devDocs/spec/<feature>-impl.md`

Purpose:
- describe how the change should be implemented
- record architectural decisions and tradeoffs
- describe module boundaries, data flow, key risks

Questions it should answer:
- Where should the change live?
- Why this design instead of another?
- What dependencies or invariants matter?
- What risks should implementation avoid?

### 5.3 Task files
Path:
- `devDocs/spec/<feature>-tasks/task-0N-<name>.md`

Purpose:
- break work into executable units
- capture sequence and dependencies
- make progress visible

A task file should contain:
- objective
- inputs / prerequisites
- implementation notes
- validation expectations
- status
- blockers, if any

Completion rule:
- completed files are renamed to `*.resolved.md`

## 6. Task State Machine

A task should move through explicit states.

Recommended states:

### draft
Task exists but is not yet ready for execution.

### planned
Task has enough definition to execute, but is not yet approved or started.

### approved
Task is approved for execution.

### in_progress
Implementation is actively happening.

### in_review
Implementation is complete enough to review, but not yet accepted.

### blocked
Task cannot proceed due to missing information, failed dependency, or external blocker.

### validated
Required checks and validation evidence have passed to the expected level.

### resolved
Task is complete, closed, and its state is reflected in artifacts and repo code.

## 6.1 State transition rules

Normal flow:
`draft -> planned -> approved -> in_progress -> in_review -> validated -> resolved`

Possible backward transitions:
- `in_review -> in_progress`
- `validated -> in_progress`
- `blocked -> planned` or `blocked -> in_progress`

Rules:
- do not move to `in_progress` without enough task clarity
- do not move to `validated` without explicit validation evidence
- do not move to `resolved` if review or validation still indicates unresolved risk
- if repo reality conflicts with task status, repo reality wins and task state must be corrected

## 7. Review Model

Review is not just “looks good” or “looks bad”.
Review should generate structured outcomes.

Recommended outcome types:

### approved
Change is acceptable as-is.

### approved_with_minor_followups
Change is acceptable; remaining issues are minor and can be deferred or handled separately.

### changes_requested
Implementation is not acceptable yet and requires revision.

### blocked_external
Review cannot conclude because something external is missing.

### needs_clarification
The change cannot be judged correctly because the task/spec is still unclear.

These outcomes should drive orchestration behavior rather than forcing ad hoc judgment each time.

## 8. Validation Contract

Validation is required for every meaningful change.

At minimum, validation should answer:
- what was tested or checked
- how it was checked
- what result was observed
- what remains unverified

## 8.1 Typical validation sources
- `pnpm run check`
- `pnpm run test`
- `npx tsc --noEmit`
- focused manual behavior checks
- runtime observation
- logs / traces / screenshots when relevant

## 8.2 Validation standard by task type

For trivial work:
- minimum relevant checks are enough

For non-trivial work:
- validation should be written down in task/review notes or final report
- if not all validation can be done, unresolved areas must be stated explicitly

A task with incomplete validation is not “done”; it is “implemented with known validation gaps”.

## 9. Routing and Specialization

Subagents should be chosen based on task shape.

### `selfwork:haiku-dev`
Use for:
- research
- local verification
- simple edits
- low-context focused tasks

### `selfwork:architect`
Use for:
- spec generation
- implementation plans
- task decomposition
- design clarification

### `selfwork:sonnet-dev`
Use for:
- complex multi-file implementation
- medium/high-context changes
- refactors and cross-cutting behavior

### `selfwork:ts-js-expert`
Use for:
- TypeScript compiler errors
- typing repair
- narrowing and interface consistency work

The orchestrator should choose the cheapest capable agent, not the most powerful by default.

## 10. Failure Recovery

When execution fails:
1. identify whether the problem is task ambiguity, implementation error, environment issue, or missing dependency
2. check `devDocs/troubleshooting.md`
3. decide whether to retry, re-plan, re-route, or block
4. record the reason if the failure is likely to recur

Do not repeatedly retry the same failing pattern without changing either:
- the task definition
- the execution approach
- the environment assumptions

## 11. Doctrine Promotion

This repo should improve over time.

If a pattern repeats in:
- code review
- debugging
- rollback
- task confusion
- validation failure

then it should be promoted into a durable mechanism.

Promotion targets include:
- AGENTS rule
- operating-model rule
- troubleshooting entry
- test case
- lint/check script
- template improvement
- task scaffold improvement

This is how human taste becomes process, and process becomes automation.

## 12. When to Avoid Over-Process

This model is intentionally heavier than ad hoc coding.
Do not apply the full workflow to every tiny edit.

Avoid full process overhead when:
- the task is clearly trivial
- the scope is narrow
- validation is straightforward
- there is little ambiguity
- the change is easily reversible

Use the lightest process that still preserves correctness and clarity.

## 13. Definition of Done

A task is done only when all of the following are true:

- implementation exists in repo state
- task/spec state matches reality
- validation has been performed to the expected level
- remaining risk is either acceptable or explicitly recorded
- durable lessons were written back when necessary

“Code was changed” is not the same as “work is done”.
