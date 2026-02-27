# Task: Implement supervisor-based exec (OpenClaw-aligned)

Repo to modify:
- `~/software/myproject/ts/moziBot`

Reference implementation (read-only reference):
- `~/software/myproject/ts/openclaw_source_github`

Key OpenClaw reference paths to study (must read before coding):
- Exec tool entry:
  - `openclaw_source_github/src/agents/bash-tools.exec.ts`
- Exec runtime + backgrounding + yieldMs/pty:
  - `openclaw_source_github/src/agents/bash-tools.exec-runtime.ts`
- Process registry:
  - `openclaw_source_github/src/agents/bash-process-registry.ts`
- Process supervisor:
  - `openclaw_source_github/src/process/supervisor/*`
  - `openclaw_source_github/src/process/exec.ts`
- Sandbox/path boundary (for security patterns):
  - `openclaw_source_github/src/agents/sandbox.ts`
  - `openclaw_source_github/src/agents/sandbox-paths.ts`

## Objective

In moziBot, replace/augment the current one-shot host exec model with a full supervisor-backed exec design.

This must support long-running processes that survive beyond a single tool call.

## Requirements

Read and implement the design described in:
- `moziBot/docs/tasks/exec-supervisor-issues.md`

Implement (at minimum):

1) **Process supervisor layer**
- Can run child processes long-lived.
- Supports `pty` mode (node-pty) when requested.
- Supports streaming output capture and tail retrieval.
- Supports kill.
- Supports timeout kill.

2) **Durable process registry**
- Persist sessions and output tail (SQLite preferred if moziBot already uses it; otherwise JSONL under workspace).
- Provide operations:
  - `status(jobId)`
  - `tail(jobId, chars)`
  - `kill(jobId)`

3) **Tools**
- Enhance `exec` tool schema:
  - `yieldMs?: number`
  - `background?: boolean`
  - `pty?: boolean`
  - `timeoutSec?: number`
- Add a `process` tool exposing:
  - `status`, `tail`, `kill`

4) **Integration**
- Must integrate with moziBot agent manager/tool builder and respect security constraints:
  - cwd must be within workspace
  - preserve existing allowlist/policy behavior where possible

5) **Quality constraints**
- TypeScript strict; no `any`.
- Add/extend tests:
  - background lifecycle
  - yieldMs behavior
  - timeout kill
  - PTY path

## Mandatory: build + test

You MUST run build and tests and only finish if they pass.

Run these commands and include the output summaries in your final response:

- `pnpm -s test`
- `pnpm -s build`

If pnpm scripts differ, inspect `package.json` and run the closest equivalents.

## Output format

1) Start by printing an implementation plan (bullet list).
2) Then implement code changes.
3) At the end, show:
- `git diff --stat`
- test results summary
- build results summary

Do not leave TODOs; implement fully.
