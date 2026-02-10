# Sandbox Deep Dive (`src/runtime/sandbox/` + `src/container/`)

## Scope

Sandbox layer decides where commands execute (`off` host exec, `docker`, `apple-vm`, or vibebox-backed flow) and validates runtime availability.

## Key Files

- `src/runtime/sandbox/bootstrap.ts`
  - startup/reload bootstrap checks and optional auto-fix
  - per-agent target discovery from config
- `src/runtime/sandbox/executor.ts`
  - selects concrete executor (host, container service, vibebox)
  - cache key logic for executor reuse
- `src/runtime/sandbox/service.ts`
  - session-scoped container lifecycle + in-container exec
  - runtime probe with actionable hints
- `src/runtime/sandbox/host-exec.ts`
  - non-sandbox execution path with allowlist
- `src/container/runtime.ts`
  - backend abstraction over docker/container CLIs

## Selection Logic

From `executor.ts`:

1. if vibebox backend enabled -> `VibeboxExecutor`
2. else if mode is `docker` or `apple-vm` -> `SandboxService`
3. else -> host executor (`off` mode)

## Bootstrap/Probe Lifecycle

Runtime startup and config reload run sandbox bootstrap/probe through host lifecycle.

Bootstrap checks include:

- backend runtime availability (`docker info` / `container info`)
- required image existence
- optional auto-pull/prepare behavior (when fix enabled)

Probe output is surfaced as structured hints for operator diagnostics.

## What to Edit

### A) Change startup bootstrap logic

- Edit:
  - `src/runtime/sandbox/bootstrap.ts`
- Also inspect:
  - `src/runtime/host/index.ts` (bootstrap trigger points)

### B) Change backend selection rules

- Edit:
  - `src/runtime/sandbox/executor.ts`
- Also inspect:
  - config schema sandbox fields
  - `src/runtime/agent-manager.ts` executor caching

### C) Change container exec wiring

- Edit:
  - `src/runtime/sandbox/service.ts`
  - `src/container/runtime.ts`
- Also inspect:
  - workspace mount rules
  - command quoting/safety paths

## Verification

- Baseline:
  - `pnpm run test`
  - `pnpm run check`
- Focus:
  - `src/runtime/sandbox/*.test.ts`
  - runtime startup/reload tests touching probe/bootstrap

## Constraints

- Keep failure hints actionable (install/start commands, image config paths).
- Do not silently fallback between sandbox modes without explicit messaging.
- Preserve mode `off` reliability as a first-class path.
