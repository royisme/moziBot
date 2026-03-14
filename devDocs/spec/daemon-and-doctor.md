# Daemon Lifecycle & Doctor Diagnostic Framework

## 1. Problem Statement

moziBot's current process management is minimal:
- `mozi start` spawns a detached child but has no crash recovery
- `mozi stop` sends SIGTERM but has no force-kill fallback
- `mozi status` only reports running/not-running (no uptime, memory, logs)
- No `mozi restart` command exists
- No platform service integration (launchd / systemd)
- No comprehensive diagnostic tool — `mozi health` only checks static environment, not runtime state

Users need production-grade daemon management and a diagnostic tool that can identify and repair common issues.

## 2. Delivery Plan

This work will be delivered in **four phases** so that process lifecycle hardening, diagnostics, platform service integration, and optional watchdog behavior can evolve independently.

### Phase 1 — Daemon hardening + status foundation
- Add `mozi restart` as **stop + start**
- Add `mozi stop --force` with SIGKILL fallback after timeout
- Add explicit runtime shutdown cleanup hooks
- Add runtime status file with atomic writes
- Enhance `mozi status` with PID, uptime, memory, log path, freshness
- Add a minimal `mozi doctor` framework and a small set of core checks

### Phase 2 — Doctor expansion + safe repair
- Expand the doctor check registry and category coverage
- Add `--json`, category filtering, and verbose output
- Add provider, channel, disk, workspace, and lock-file checks
- Add a limited `--fix` mode for safe repairs only
- Share reusable checks with `mozi health` where practical

### Phase 3 — Platform service integration
- Add `mozi service install|uninstall|status`
- Add macOS launchd integration
- Add Linux systemd user-service integration
- Separate managed-service lifecycle from raw daemon lifecycle

### Phase 4 — Optional watchdog mode
- Revisit `mozi start --watch` after phases 1-3 are stable
- If still valuable, add supervisor/worker lifecycle for unmanaged mode only
- Define crash backoff / retry policy and observability for watchdog mode
- Keep watchdog explicitly separate from managed service mode

### Deferred / future considerations
- In-process hot reload / signal-driven graceful restart
- Windows service integration
- Remote monitoring / metrics export
- Log rotation (defer to platform service managers or logrotate)

## 3. Architecture

### 3.1 Daemon Lifecycle

#### Phase 1 acceptance criteria
- `mozi restart` works as stop + start only
- `mozi stop --force` can terminate a stuck runtime after timeout
- runtime host performs explicit shutdown cleanup and removes transient state on graceful exit
- runtime status is observable through a status file with freshness detection
- `mozi status` can render richer runtime information without requiring a live IPC channel
- `mozi doctor` can run a small core check set without depending on future provider/channel/service features

**Phase 1 command surface:**

```
mozi start [--foreground]
mozi stop [--force] [--timeout <ms>]
mozi restart
mozi status [--json]
```

**Deferred to phase 3:**

```
mozi service install|uninstall|status
```

**Explicitly deferred beyond phase 1:**
- `mozi start --watch`
- signal-driven in-process restart / hot reload

#### 3.1.1 Graceful Shutdown Protocol

Runtime host must handle shutdown cleanly:

```
SIGTERM received
  → Set shutdown flag (reject new work)
  → Drain active requests (5s timeout)
  → Close channel adapters
  → Close database connections
  → Remove PID file
  → Exit 0
```

If drain timeout expires, log warning and proceed with shutdown.

#### 3.1.2 Force Stop (`--force`)

```
mozi stop --force [--timeout 5000]
```

1. Send SIGTERM
2. Poll for `timeout` ms (default 10s)
3. If still running and `--force` is set, send SIGKILL
4. If the process exits, clean up the PID file if it is stale

Without `--force`, timeout remains a user-visible failure and no hard kill is attempted.

#### 3.1.3 Restart

```
mozi restart
```

Phase 1 restart is intentionally simple:
- stop (SIGTERM + wait, optionally forceable through stop path)
- then start

This avoids assuming that the runtime host can safely reload configuration, reconnect channels, or reconstruct internal state in-process.

#### 3.1.4 Enhanced Status

```
mozi status [--json]
```

Output:
```
Mozi Runtime Status
  Status:   running
  PID:      12345
  Uptime:   2h 34m
  Memory:   48 MB RSS
  Config:   ~/.mozi/config.jsonc
  Log:      ~/.mozi/logs/mozi.log
  Mode:     daemon
  Channels: discord (connected), telegram (connected)
```

Implementation: read PID file, query `/proc/<pid>/stat` (Linux) or `ps` (macOS) for memory/uptime. Channel status requires a lightweight IPC mechanism (see 3.1.6).

#### 3.1.5 Runtime Status File

For `mozi status` to report channel health and runtime details, phase 1 uses a lightweight **status file** instead of an IPC socket.

**Decision: status file** — simpler, easier to debug, no socket lifecycle management, and still useful if the runtime becomes unresponsive because consumers can inspect the last successful write time.

Requirements:
- Write to a temp file and `rename()` into place atomically
- Use restrictive file permissions
- Include `updatedAt` so readers can detect stale snapshots
- Treat stale or unreadable status files as degraded status, not as fatal CLI errors

Status file schema:
```typescript
interface RuntimeStatus {
  pid: number;
  startedAt: string;          // ISO 8601
  updatedAt: string;          // ISO 8601
  mode: "daemon" | "foreground";
  config: string;             // config file path
  channels: Array<{
    id: string;
    type: string;             // "discord" | "telegram" | ...
    status: "connected" | "disconnected" | "error";
    error?: string;
  }>;
  memory: {
    rss: number;              // bytes
    heapUsed: number;         // bytes
    heapTotal: number;        // bytes
  };
  agents: {
    active: number;
    total: number;
  };
}
```

The runtime host writes this file on startup and refreshes it every 10 seconds via `setInterval`. On graceful shutdown it deletes the file. If the process crashes, the stale file is left behind and interpreted via `updatedAt` freshness checks.

### 3.2 Platform Service Integration (Phase 3)

```
mozi service install   — install as system service
mozi service uninstall — remove system service
mozi service status    — check service registration
```

Phase 3 is intentionally separated from the raw daemon lifecycle. In managed-service mode, the operating system service manager is the source of truth for start/stop/restart semantics. PID-file-based lifecycle commands remain useful for unmanaged daemon mode, but service mode should rely on native platform controls.

#### 3.2.1 macOS (launchd)

Generates a plist at an absolute path such as `/Users/<user>/Library/LaunchAgents/ai.mozi.runtime.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ...>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.mozi.runtime</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/mozi</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/&lt;user&gt;/.mozi/logs/mozi.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/&lt;user&gt;/.mozi/logs/mozi.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MOZI_CONFIG</key>
    <string>/Users/&lt;user&gt;/.mozi/config.jsonc</string>
  </dict>
</dict>
</plist>
```

Note: when using launchd, `--foreground` is used because launchd manages the process lifecycle. All generated paths must be absolute. `KeepAlive.SuccessfulExit=false` means launchd restarts on crash but not on clean exit.

#### 3.2.2 Linux (systemd)

Generates a user unit at an absolute path such as `/Users/<user>/.config/systemd/user/mozi.service`:

```ini
[Unit]
Description=Mozi AI Runtime
After=network-online.target

[Service]
Type=exec
ExecStart=/path/to/mozi start --foreground
Restart=on-failure
RestartSec=5
Environment=MOZI_CONFIG=/Users/<user>/.mozi/config.jsonc

[Install]
WantedBy=default.target
```

After writing the unit file, run `systemctl --user daemon-reload`. In service mode, stop/restart semantics should be delegated to systemd rather than shelling through `mozi stop`.

#### 3.2.3 Platform Abstraction

```typescript
interface PlatformService {
  readonly platform: "launchd" | "systemd" | "unsupported";
  install(options: ServiceInstallOptions): Promise<ServiceResult>;
  uninstall(): Promise<ServiceResult>;
  status(): Promise<ServiceStatus>;
}

interface ServiceInstallOptions {
  moziExecutable: string;   // resolved path to mozi CLI
  configPath: string;
  logPath: string;
  autoStart?: boolean;      // start on boot/login, default false
}

interface ServiceResult {
  success: boolean;
  message: string;
  filePath?: string;        // path to generated service file
}

interface ServiceStatus {
  installed: boolean;
  running: boolean;
  enabled: boolean;         // auto-start on boot
  filePath?: string;
}
```

### 3.3 Doctor Framework

#### 3.3.1 Check Interface

```typescript
interface DoctorCheck {
  name: string;
  category: DoctorCategory;
  description: string;
  run(ctx: DoctorContext): Promise<CheckResult>;
}

type DoctorCategory =
  | "environment"
  | "config"
  | "runtime"
  | "storage"
  | "providers"
  | "channels"
  | "security";

interface CheckResult {
  status: "pass" | "warn" | "fail" | "skip";
  message: string;
  detail?: string;
  repair?: RepairAction;
}

interface RepairAction {
  description: string;
  safe: boolean;            // can be auto-applied with --fix
  apply(ctx: DoctorContext): Promise<RepairResult>;
}

interface RepairResult {
  success: boolean;
  message: string;
}

interface DoctorContext {
  config: MoziConfig | null;
  configPath: string;
  verbose: boolean;
  json: boolean;
  fix: boolean;
}
```

#### 3.3.2 Check Registry

Same pattern as ConfigureSection registry:

```typescript
class DoctorCheckRegistry {
  readonly #checks = new Map<string, DoctorCheck>();

  register(check: DoctorCheck): void { ... }
  list(): DoctorCheck[] { ... }           // sorted by category
  byCategory(cat: DoctorCategory): DoctorCheck[] { ... }
}
```

#### 3.3.3 CLI Interface

```
mozi doctor [--fix] [--json] [--category <cat>] [--verbose]
```

Output format (interactive):
```
🔍 Mozi Doctor

  Environment
    ✓ Node.js version            v22.5.0
    ✓ Disk space                 42 GB available
    ⚠ Bun not found              Install bun for faster startup (optional)

  Configuration
    ✓ Config file valid           ~/.mozi/config.jsonc
    ✗ No providers configured     Run: mozi configure provider

  Runtime
    ✓ Daemon running              PID 12345, uptime 2h
    ✓ Status file fresh           Updated 3s ago
    ⚠ Stale lock file found       Auto-fixable with --fix

  Storage
    ✓ Database accessible         ~/.mozi/data/mozi.db
    ✓ Migrations up to date       v12

  Providers
    ✓ OpenAI API reachable        200 OK (145ms)
    ✗ Anthropic API key missing   Set via: mozi configure secrets

  Channels
    ✓ Discord connected           Bot user: Mozi#1234
    ⚠ Telegram polling slow       Last poll: 15s ago (threshold: 10s)

  3 passed, 2 warnings, 2 failures
  Run with --fix to auto-repair 1 issue.
```

JSON output (`--json`):
```json
{
  "checks": [
    {
      "name": "Node.js version",
      "category": "environment",
      "status": "pass",
      "message": "v22.5.0"
    }
  ],
  "summary": {
    "pass": 3,
    "warn": 2,
    "fail": 2,
    "skip": 0,
    "repairable": 1
  }
}
```

#### 3.3.4 Core Checks by Phase

**Phase 1 core checks**

| Check | Category | Description | Auto-repair |
|-------|----------|-------------|-------------|
| Node.js version | environment | >= 22 required, 20 warn | No |
| Config file | config | Exists and parses | No |
| Runtime running | runtime | PID file + process alive | Clean stale PID |
| Status file fresh | runtime | Updated within 30s | No |
| Database accessible | storage | Can open and query SQLite | No |
| Secret store readable | storage | Can access secret backends | No |

**Phase 2 additional checks**

| Check | Category | Description | Auto-repair |
|-------|----------|-------------|-------------|
| Disk space | environment | Warn < 1GB, fail < 100MB | No |
| Providers configured | config | At least one provider | No |
| Model aliases set | config | Default model alias exists | No |
| Stale lock files | runtime | No orphaned lock files | Delete stale locks |
| Migrations current | storage | Schema version matches code | Run migrations |
| Provider API reachable | providers | Provider-specific lightweight connectivity check | No |
| API key present | providers | Each configured provider has a key | No |
| Channel adapter health | channels | Read from status file | No |

#### 3.3.5 Relationship to `mozi health`

`mozi health` is the existing lightweight pre-flight check (static environment). `mozi doctor` is the comprehensive diagnostic tool (runtime + connectivity + repair).

Options:
1. **Keep both** — `health` stays as quick pre-flight, `doctor` is deep diagnostic
2. **Merge** — deprecate `health`, move its checks into doctor

**Decision: Option 1 (keep both)** — `health` is fast and has no runtime dependency, useful in CI/scripts. `doctor` is thorough and interactive, useful for troubleshooting.

## 4. File Structure

### Phase 1

```
src/
  cli/commands/
    restart.ts                 # new: mozi restart
    doctor.ts                  # new: mozi doctor CLI entry
  daemon/
    shutdown.ts                # new: graceful shutdown protocol
    status-writer.ts           # new: periodic status file writer
    types.ts                   # new: RuntimeStatus, etc.
  doctor/
    types.ts                   # new: DoctorCheck, CheckResult, etc.
    registry.ts                # new: DoctorCheckRegistry
    runner.ts                  # new: orchestrates checks
    reporter.ts                # new: interactive + JSON output formatting
    index.ts                   # new: registerAllChecks + runDoctor
    checks/
      environment.ts           # new: node version
      config.ts                # new: config validity
      runtime.ts               # new: daemon running, status file
      storage.ts               # new: database, secrets
```

### Phase 2 additions

```
src/doctor/checks/
  providers.ts                 # new: provider connectivity, key presence
  channels.ts                  # new: channel adapter health
  workspace.ts                 # new: disk space, workspace integrity, locks
```

### Phase 3 additions

```
src/
  cli/commands/
    service.ts                 # new: mozi service install|uninstall|status
  daemon/service/
    types.ts                   # new: PlatformService interface
    launchd.ts                 # new: macOS launchd integration
    systemd.ts                 # new: Linux systemd integration
    detect.ts                  # new: platform detection
```

## 5. Integration Points

### 5.1 Runtime Host Changes

The runtime host (`src/runtime/host/main.ts`) needs:
- Import and start `StatusWriter` on boot
- Register SIGTERM/SIGINT/SIGUSR2 handlers via `shutdown.ts`
- Call `StatusWriter.stop()` + `Lifecycle.removePid()` on shutdown

### 5.2 Existing Command Changes

**Phase 1**
- `start.ts`: keep current start modes, but integrate status file + shutdown hooks for the spawned runtime
- `stop.ts`: add `--force` and `--timeout` flags
- `status.ts`: read status file for enhanced output, add `--json` flag

**Phase 3**
- add managed-service lifecycle wiring once `service` commands exist

### 5.3 CLI Router

**Phase 1:** register `restart`, `doctor`.

**Phase 3:** register `service`.

## 6. Error Handling

- Doctor checks: each check is isolated — one failing check does not abort others
- Service install: validate paths exist before writing service file; never overwrite without `--force`
- Status file: if write fails (disk full, permissions), log warning but don't crash runtime

## 7. Testing Strategy

- **Shutdown**: unit test signal handling, mock channel/db close
- **Status writer**: unit test serialization, integration test file write/read cycle
- **Service**: unit test plist/unit file generation (snapshot tests), skip actual install in CI
- **Doctor checks**: unit test each check with mocked context, integration test registry + runner
- **Doctor reporter**: snapshot test interactive and JSON output formatting

## 8. Migration from `mozi health`

No breaking changes. `mozi health` continues to work as-is. The doctor check for "config" and "environment" categories covers a superset of what health checks. In the future, if we want to deprecate `health`, we can alias it to `doctor --category environment,config --no-fix`.
