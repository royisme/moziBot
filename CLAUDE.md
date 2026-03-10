This file is the entrypoint for agent work in this repository.
It defines where to look, how to classify work, and the minimum execution rules.

Detailed methodology and long-lived process design live in:
- `devDocs/agent-operating-model.md`
- `devDocs/troubleshooting.md`
- `devDocs/spec/`

## 1. Source of Truth

When an agent needs context, use these sources in order of relevance:

- Project scripts / dependencies / runtime assumptions → `package.json`
- Feature intent and implementation guidance → `docs/spec/`
- Long-lived process and artifact rules → `docs/agent-operating-model.md`
- Troubleshooting and known issue patterns → `docs/troubleshooting.md`

Do not treat chat context or runtime notes as durable project truth unless they are written back into repo docs.

## 2. Tech Stack and Commands

### Tech stack discovery
- Need runtime or dependency details → check `package.json`
- Need Bun API details → check `node_modules/bun-types/docs/`

### Package manager / script runner
- Install / manage packages with `pnpm`
- Run scripts with `pnpm run <script>`

### Common commands
- Check (lint + format): `pnpm run check`
- Test: `pnpm run test`
- Type check only: `npx tsc --noEmit`

### Git hooks
- `pre-commit` should run: `pnpm run check`
- `pre-push` should run: `pnpm run test`

## 3. MCP Tool Usage

Before starting work, first confirm which MCP tools are available in the current session.

Guidelines:
- For large-output commands, prefer compressed / structured MCP tools instead of raw Bash output
- For third-party library docs, prefer documentation-query MCP tools
- For symbol-aware code operations, prefer symbol-level MCP tools

## 4. Task Classification

### Trivial changes
A task is usually trivial if most of the following are true:
- touches only 1–2 files
- no new interface / schema / workflow
- no new spec needed
- easy to validate locally with minimal checks
- low risk and easily reversible

Handling:
- execute directly
- validate before finishing
- briefly summarize what changed and how it was verified

### Non-trivial changes
Treat the task as non-trivial if any of the following are true:
- multi-file or cross-module changes
- introduces or changes interface / state flow / schema / build behavior
- requires design clarification
- requires staged execution
- likely to need rollback reasoning, review, or explicit task tracking

Handling:
- create plan/spec/tasks first
- execute in steps
- validate each meaningful step
- update task status as work progresses

## 5. Required Workflow for Non-trivial Work

Default flow:

1. Clarify
2. Plan
3. Execute
4. Review
5. Validate
6. Resolve

Do not jump directly into implementation for non-trivial work unless the task already has an approved and sufficiently clear spec/task context.

## 6. Artifact Rules

### Feature docs
- Spec: `devDocs/spec/<feature>.md`  
  Purpose: what / why / scope / constraints

- Implementation guide: `devDocs/spec/<feature>-impl.md`  
  Purpose: how / architecture / tradeoffs / execution notes

### Task docs
- Task files: `devDocs/spec/<feature>-tasks/task-0N-<name>.md`
- Completed tasks must be renamed to: `task-0N-<name>.resolved.md`
- No `.resolved` suffix means not completed

If task state becomes unclear, do not guess. Reconstruct it from the task file, validation evidence, and actual repo state.

## 7. Agent Routing

Use the following routing defaults:

- research / validation / simple edits → `selfwork:haiku-dev`
- spec / task document generation → `selfwork:architect`
- complex multi-file implementation → `selfwork:sonnet-dev`
- TypeScript type error fixing → `selfwork:ts-js-expert`

Route by task shape, complexity, and expected output, not by habit.

## 8. Execution Behavior

- If intent is clear and the action is reversible, execute directly and summarize afterward
- If action is irreversible, affects production, or lacks key information, confirm first
- For multi-step work: change one step, validate one step
- Never batch many risky edits without intermediate validation

## 9. Validation Minimum

Every completed task or meaningful change must include, explicitly or implicitly:

- what changed
- how it was validated
- result of validation
- any remaining risk / limitation / follow-up

Passing validation matters more than claiming completion.

## 10. Troubleshooting Discipline

When blocked or debugging:
- check `devDocs/troubleshooting.md` first

After resolving an issue:
- add the root cause
- add the fix
- place it under the appropriate category

Do not leave recurring failure patterns only in chat history.

## 11. Doctrine Promotion

If the same class of issue appears repeatedly in review, debugging, or rework, promote it into one of:
- a rule in `AGENTS.md`
- a process rule in `devDocs/agent-operating-model.md`
- a troubleshooting entry
- a script/check
- a test case
- a template improvement

Repeated mistakes must become repo-level learning.
