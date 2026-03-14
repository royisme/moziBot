This file is the entrypoint for agent work in this repository.
Keep it short, executable, and safe to compress.

Detailed docs live in:
- `devDocs/agent-operating-model.md`
- `devDocs/troubleshooting.md`
- `devDocs/spec/`
- `.claude/rules/workflow.md`
- `.claude/rules/artifacts.md`
- `.claude/rules/troubleshooting.md`
- `.claude/rules/routing.md`
- `HANDOFF.md`

## 1. Source of truth

When you need context, use these sources in order:
- project scripts, dependencies, runtime assumptions -> `package.json`
- feature intent and implementation guidance -> `devDocs/spec/`
- current continuation state -> `HANDOFF.md`
- workflow and artifact rules -> `.claude/rules/`
- long-lived process design -> `devDocs/agent-operating-model.md`
- troubleshooting patterns -> `devDocs/troubleshooting.md`

Do not treat chat history or compressed context as durable truth unless written back into repo files.

## 2. Commands

- package manager: `pnpm`
- script runner: `pnpm run <script>`
- check: `pnpm run check`
- test: `pnpm run test`
- typecheck: `npx tsc --noEmit`

Git hooks should enforce:
- pre-commit -> `pnpm run check`
- pre-push -> `pnpm run test`

## 3. Workflow

- Trivial work: execute directly, validate, summarize.
- Non-trivial work: clarify, plan, execute in steps, review, validate, resolve.
- Do not jump into non-trivial implementation without approved or clearly established repo artifacts.
- For detailed rules, read `.claude/rules/workflow.md` and `.claude/rules/artifacts.md`.

## 4. Validation

Every meaningful change must state:
- what changed
- how it was validated
- validation result
- remaining risk, limitation, or follow-up

Passing validation matters more than claiming completion.

## 5. Compact Instructions

When context is compressed, preserve this information in this order:
1. architecture decisions - never summarize away
2. modified files and key changes
3. current verification status with pass/fail state
4. open TODOs, blockers, and rollback notes
5. tool output details may be collapsed to pass/fail only

Session hygiene:
- use `/clear` when switching to a different task
- use `/compact` between major phases of the same task
- use `/context` proactively in long sessions

## 6. Execution constraints

- Prefer structured MCP tools for large outputs.
- Prefer symbol-aware tools for targeted code edits.
- If blocked, check `devDocs/troubleshooting.md` first.
- If a recurring issue appears more than once, promote it into durable repo guidance, tests, or checks.
