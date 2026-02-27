# Issues: moziBot exec/background supervision vs openclaw design

## Goal

Implement a **full, supervisor-based exec design** in `moziBot` aligned with the `openclaw_source_github` model:

- Long-running processes must be able to **survive beyond a single tool call**.
- `exec` tool should support:
  - `yieldMs`: run for a bit, then return while process continues
  - `background`: background immediately
  - `pty`: run under a pseudo-terminal for TTY-required tools
  - `timeoutSec`: kill after timeout
  - process registry: `status`, `tail`, `kill`
  - notifications / system events when backgrounded process exits
- Exec host abstraction consistent with current architecture:
  - host = `sandbox | gateway | node` (or current equivalents)

This is required to support workflows like: start a local HTTP file server and keep it running while the agent returns.

## Problem Statement (current behavior)

In `moziBot`, host exec is implemented as a one-shot `execFile("/bin/sh", ["-lc", command])` with a default timeout.
This execution model is inherently **non-daemon-friendly** and does not provide durable process handles.

Observed symptom:
- Starting a server prints the "Serving ..." log then the process is immediately gone / tool returns.

## Reference Implementation (openclaw)

Key reference paths (in `~/software/myproject/ts/openclaw_source_github`):

- Exec tool entry:
  - `src/agents/bash-tools.exec.ts`
    - Supports `yieldMs/background`, `pty`, longer default timeouts (e.g. 1800s)
    - Uses a process registry (`bash-process-registry`) and supervisor (`process/supervisor`)

- Exec runtime:
  - `src/agents/bash-tools.exec-runtime.ts`
    - Uses `getProcessSupervisor()` and `ManagedRun`
    - Writes to `bash-process-registry`: `addSession/appendOutput/markExited/tail`

- Process supervision:
  - `src/process/supervisor/*` and `src/process/exec.ts`

- Sandbox model:
  - `src/agents/sandbox.ts`, `src/agents/sandbox-paths.ts`
  - Docs: `docs/tools/exec.md`, `docs/gateway/sandboxing.md`, `docs/refactor/exec-host.md`

## Proposed moziBot Design (high-level)

### A) Process Supervisor Layer

Add `src/process/supervisor/` (or equivalent) to:

- spawn processes with either:
  - PTY mode (node-pty)
  - non-PTY mode (child_process.spawn)
- stream stdout/stderr (or PTY output) into an in-memory ring buffer and durable store
- expose:
  - `start()` -> returns `ManagedRun` { id, pid, kill(), onOutput(cb), promise/outcome }
  - `get(id)`
  - `kill(id)`
  - `tail(id, nChars)`

### B) Process Registry (durable)

Add `src/runtime/process-registry.ts` backed by SQLite (preferred) or JSONL under workspace:

- tables/records:
  - process id
  - command
  - cwd
  - startedAt
  - status (running/exited)
  - exitCode/signal
  - output (chunked) or pointers to output file
  - backgrounded flag

### C) Tooling

1) Enhance `exec` tool schema:
- `yieldMs?: number`
- `background?: boolean`
- `pty?: boolean`
- `timeoutSec?: number`

2) Add `process` tool:
- `process.status <id>`
- `process.tail <id> [--chars]`
- `process.kill <id>`

### D) Notifications

When a backgrounded job exits:
- create a system event
- request a heartbeat wake

### E) Security & Boundaries

- Keep existing allowlist / tool policy logic.
- Ensure PTY + background respects sandbox boundary.
- Ensure cwd remains within workspace.

## Acceptance Criteria

- `exec` with `background=true` returns immediately with a jobId.
- Process continues running and is visible via `process.status`.
- `process.tail` returns live output.
- `process.kill` terminates it.
- `yieldMs` runs for specified ms then backgrounds.
- PTY mode works for TTY-required commands.

## Work Plan

1) Read and distill openclaw supervisor + registry patterns.
2) Map moziBot current runtime/tool builder architecture.
3) Implement supervisor + registry.
4) Add/upgrade tools: exec + process.
5) Add tests:
   - background lifecycle
   - yieldMs behavior
   - timeout kill
   - PTY path
6) Document in moziBot `AGENTS.md` / docs.

## Notes

This is intentionally **not** a minimal patch; it is an architectural alignment with the openclaw model.
