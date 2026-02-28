# Exec Supervisor Implementation

This document describes the supervisor-based exec implementation that enables long-running background processes in moziBot.

## Overview

The exec system now supports:
- **Background execution**: Start processes that continue running after the tool call returns
- **yieldMs**: Run for N milliseconds, then return control while the process continues
- **PTY support**: Run commands in pseudo-terminals for TTY-required tools
- **Timeout kill**: Automatically kill processes after a specified timeout
- **Process management**: Query status, view output, and kill background processes

## Architecture

### Components

1. **ProcessSupervisor** (`src/process/supervisor.ts`)
   - Spawns and manages processes (PTY and non-PTY modes)
   - Streams output to callbacks and buffers
   - Handles timeout-based killing

2. **ProcessRegistry** (`src/process/process-registry.ts`)
   - SQLite-backed durable storage for process records
   - Stores: command, cwd, status, exit code, output tail
   - Provides: `addSession`, `appendOutput`, `markExited`, `tail`, `getStatus`

3. **ManagedRun** (`src/process/managed-run.ts`)
   - High-level wrapper for process lifecycle
   - Tracks status: `running` → `exited` or `error`
   - Provides output callbacks and outcome promise

4. **Exec Tool** (`src/runtime/sandbox/tool.ts`)
   - Extended schema with `yieldMs`, `background`, `pty`, `timeoutSec`
   - Routes background jobs to supervisor

5. **Process Tool** (`src/process/process-tool.ts`)
   - Operations: `status`, `tail`, `kill`
   - Query and manage background processes

## Usage

### Basic Background Execution

```json
{
  "tool": "exec",
  "args": {
    "command": "python -m http.server 8000",
    "background": true
  }
}
```

Response:
```
Process started in background (jobId: job_1234567890_abc123, pid: 12345). 
Use 'process status job_1234567890_abc123' to check status, 
'process tail job_1234567890_abc123' to view output, 
'process kill job_1234567890_abc123' to terminate.
```

### yieldMs - Run Then Background

```json
{
  "tool": "exec",
  "args": {
    "command": "npm run dev",
    "yieldMs": 5000
  }
}
```

Runs for 5 seconds, captures initial output, then backgrounds automatically.

### PTY Mode

```json
{
  "tool": "exec",
  "args": {
    "command": "vim file.txt",
    "pty": true,
    "background": true
  }
}
```

Required for interactive TTY applications.

### Timeout

```json
{
  "tool": "exec",
  "args": {
    "command": "long-running-task",
    "timeoutSec": 3600,
    "background": true
  }
}
```

Process will be killed after 1 hour if still running.

### Process Management

Check status:
```json
{
  "tool": "process",
  "args": {
    "operation": "status",
    "jobId": "job_1234567890_abc123"
  }
}
```

View output:
```json
{
  "tool": "process",
  "args": {
    "operation": "tail",
    "jobId": "job_1234567890_abc123",
    "chars": 1000
  }
}
```

Kill process:
```json
{
  "tool": "process",
  "args": {
    "operation": "kill",
    "jobId": "job_1234567890_abc123"
  }
}
```

List all running processes (omit jobId):
```json
{
  "tool": "process",
  "args": {
    "operation": "status"
  }
}
```

## Tool Configuration

Add `process` to your agent's tool allowlist:

```yaml
agents:
  - id: coding-agent
    tools:
      - exec
      - process  # Required for background process management
      - read
      - write
      - edit
```

## Security

- Cwd validation: Paths must be within workspace directory
- Allowlist policy: Existing exec allowlist applies
- Protected env vars: `*_API_KEY` patterns blocked from direct env, use `authRefs`

## Data Persistence

Process records are stored in `.mozi/data/process-registry.db` (SQLite).
- Output tail limited to 32KB per process
- Old exited sessions can be cleaned up via `cleanupOldSessions`

## API Reference

### Exec Tool Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `command` | string | Shell command to execute (required) |
| `cwd` | string? | Working directory (relative to workspace) |
| `env` | Record<string,string>? | Environment variables |
| `authRefs` | string[]? | Secret references to inject |
| `yieldMs` | number? | Run for N ms then background |
| `background` | boolean? | Background immediately |
| `pty` | boolean? | Run in pseudo-terminal |
| `timeoutSec` | number? | Kill after N seconds |

### Process Tool Operations

| Operation | Parameters | Description |
|-----------|------------|-------------|
| `status` | `jobId`? | Get process status; omit jobId for list |
| `tail` | `jobId`, `chars`? | Get output (last N chars) |
| `kill` | `jobId` | Terminate process |

## Testing

Run tests:
```bash
pnpm run test src/process
```

Test coverage:
- `process-registry.test.ts`: Registry CRUD operations
- `supervisor.test.ts`: Process lifecycle, timeout, kill
- `managed-run.test.ts`: ManagedRun wrapper behavior

## Migration Notes

- Existing one-shot exec calls continue to work unchanged
- Background execution requires `process` tool in allowlist
- Process IDs are generated as `job_<timestamp>_<random>`
