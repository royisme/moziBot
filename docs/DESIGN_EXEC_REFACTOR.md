# Exec/Sandbox Architecture Refactor Design

## Problem Statement

moziBot's current exec architecture has a fundamental design flaw: **execution is coupled to sandbox**.

### Current (Flawed) Architecture

```
createExecTool(executor: SandboxExecutor)
  └── SandboxExecutor.exec()         ← exec is a method OF sandbox
       ├── HostSandboxExecutor       ← uses execFile("/bin/sh", ...)
       ├── SandboxService            ← docker/apple-vm
       └── VibeboxExecutor           ← vibebox

createExecTool also directly calls:
  └── getProcessSupervisor()         ← for background jobs only
```

**Problems:**
1. `SandboxExecutor` is responsible for execution — sandbox should only define boundaries/config
2. The `exec` tool has two execution paths: `SandboxExecutor.exec()` for one-shot, `ProcessSupervisor.start()` for background — inconsistent
3. `host-exec.ts` uses `execFile` with a 120s timeout — cannot support long-running processes
4. Background execution bypasses the sandbox entirely (goes directly to supervisor)
5. Sandbox config and exec logic are tightly coupled — adding a new execution mode requires modifying sandbox

### Target (openclaw-aligned) Architecture

```
ExecTool
  └── ExecRuntime
       ├── resolves sandbox config (cwd boundaries, env filtering)
       ├── resolves auth (authRefs → secrets)
       └── delegates to ProcessSupervisor.start()
            ├── mode: "spawn" (standard processes)
            ├── mode: "pty" (pseudo-terminal)
            └── ManagedRun tracks lifecycle

ProcessSupervisor
  ├── start() → ProcessHandle
  ├── get(id) → ManagedRun
  ├── kill(id)
  └── uses ProcessRegistry for durable state

Sandbox (pure config)
  ├── SandboxConfig: { mode, boundaries, allowlist }
  ├── resolveCwd(workspace, cwd) → validated path
  └── buildSafeEnv(config, override) → filtered env
```

**Key principle:** Sandbox defines WHERE and WHAT constraints. ProcessSupervisor handles HOW to execute. ExecRuntime bridges the two.

## Detailed Design

### Phase 1: Extract Sandbox as Pure Config

**Goal:** Sandbox becomes a configuration/validation layer only, no exec methods.

#### New: `src/runtime/sandbox/config.ts`

```typescript
export interface SandboxBoundary {
  workspaceDir: string;
  allowlist?: string[];
  blockedEnvKeys?: string[];
  mode: 'off' | 'docker' | 'apple-vm' | 'vibebox';
}

export function resolveCwd(boundary: SandboxBoundary, cwd?: string): string {
  // Move from host-exec.ts
  // Validates cwd is within workspace
}

export function buildSafeEnv(
  boundary: SandboxBoundary,
  override?: Record<string, string>
): Record<string, string> {
  // Move from host-exec.ts
  // Filters blocked env keys
}

export function validateCommand(
  command: string,
  allowlist?: string[]
): { ok: true } | { ok: false; reason: string } {
  // Move command extraction + allowlist check from host-exec.ts
}
```

**Changes:**
- `SandboxExecutor` interface loses `exec()` method — becomes `SandboxConfig` only
- `host-exec.ts` becomes a thin wrapper or is deleted
- `resolveCwd`, `buildSafeEnv`, `extractCommandNames` move to `config.ts`

### Phase 2: Unify Execution Through ProcessSupervisor

**Goal:** ALL execution (one-shot and background) goes through ProcessSupervisor.

#### Extend: `src/process/supervisor.ts`

```typescript
export interface ProcessStartParams {
  id: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  pty?: boolean;
  timeoutSec?: number;
  // New: support one-shot mode
  waitForExit?: boolean;
  maxBuffer?: number;
}

export interface ProcessHandle {
  id: string;
  pid: number;
  kill: () => void;
  onOutput: (cb: (data: string) => void) => void;
  promise: Promise<ProcessOutcome>;
}
```

Currently, one-shot exec uses `execFile("/bin/sh", ["-lc", cmd])` while background uses `supervisor.start()` which uses `spawn`. Unifying means:

- One-shot: `supervisor.start({ waitForExit: true })` — spawns, collects output, returns when done
- Background: `supervisor.start({ ... })` — spawns, returns handle immediately
- yieldMs: `supervisor.start({ ... })` + timer-based yield

This eliminates the dual execution path.

### Phase 3: Create ExecRuntime

**Goal:** Single entry point that composes sandbox config + supervisor.

#### New: `src/runtime/exec-runtime.ts`

```typescript
export class ExecRuntime {
  constructor(
    private supervisor: ProcessSupervisor,
    private registry: ProcessRegistry,
    private boundary: SandboxBoundary,
    private authResolver?: AuthResolver,
  ) {}

  /**
   * Execute a command (one-shot or background).
   * This is the ONLY execution entry point.
   */
  async execute(params: ExecRequest): Promise<ExecResult> {
    // 1. Validate command against allowlist
    // 2. Resolve cwd within sandbox boundary
    // 3. Build safe env + resolve authRefs
    // 4. Determine execution mode (one-shot / yield / background)
    // 5. Delegate to supervisor.start()
    // 6. Return result
  }
}
```

### Phase 4: Rewrite Exec Tool

**Goal:** Exec tool becomes a thin wrapper around ExecRuntime.

```typescript
export function createExecTool(params: {
  runtime: ExecRuntime;  // replaces executor: SandboxExecutor
  agentId: string;
  sessionKey: string;
}): AgentTool {
  return {
    name: 'exec',
    execute: async (_toolCallId, args) => {
      const result = await params.runtime.execute({
        ...normalizeExecArgs(args),
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      });
      return formatExecResult(result);
    },
  };
}
```

### Phase 5: Update Tool Builder / Agent Manager

Update `tool-builder.ts` and `agent-manager` to:
1. Create `SandboxBoundary` from config (instead of `SandboxExecutor`)
2. Create `ExecRuntime` with boundary + supervisor + registry
3. Pass `ExecRuntime` to `createExecTool`

## File Change Summary

| File | Action | Description |
|------|--------|-------------|
| `src/runtime/sandbox/config.ts` | **New** | Pure sandbox config + validation |
| `src/runtime/exec-runtime.ts` | **New** | Unified execution runtime |
| `src/runtime/sandbox/executor.ts` | **Delete** | Replaced by config.ts + exec-runtime.ts |
| `src/runtime/sandbox/host-exec.ts` | **Delete** | Logic moves to config.ts + supervisor |
| `src/runtime/sandbox/service.ts` | **Modify** | Becomes sandbox config provider only |
| `src/runtime/sandbox/tool.ts` | **Rewrite** | Thin wrapper around ExecRuntime |
| `src/process/supervisor.ts` | **Extend** | Add one-shot support (waitForExit) |
| `src/runtime/agent-manager/tool-builder.ts` | **Modify** | Use ExecRuntime instead of SandboxExecutor |
| `src/runtime/tools.ts` | **Modify** | Update tool creation |

## Migration Strategy

1. **Phase 1-2 can be done without breaking existing tests** — extract config, extend supervisor
2. **Phase 3 creates ExecRuntime** alongside existing code (dual-path)
3. **Phase 4-5 switches over** — update tool creation, remove old executor
4. **Final cleanup** — delete dead code, update docs

Each phase should have its own PR with passing tests.

## Testing Strategy

- Unit tests for `SandboxBoundary` validation (cwd, env, allowlist)
- Unit tests for `ExecRuntime` with mocked supervisor
- Integration tests for one-shot execution through supervisor
- Integration tests for background + yieldMs execution
- Regression: existing exec tool tests must pass through each phase

## Security Considerations

- Allowlist enforcement moves from host-exec to SandboxBoundary — must be tested
- Env filtering (BLOCKED_ENV_KEYS) moves to SandboxBoundary — must be tested
- Auth resolution stays in ExecRuntime — no change in security model
- cwd validation moves to SandboxBoundary — must be tested
- PTY + background still respect sandbox boundaries through ExecRuntime
