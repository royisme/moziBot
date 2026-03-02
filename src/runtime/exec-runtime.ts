import { resolveSystemRunCommand, formatExecCommand } from "../infra/system-run-command.js";
import { logger } from "../logger.js";
import { type ProcessRegistry } from "../process/process-registry.js";
import { resolveCommand, sanitizeBinaryOutput } from "../process/shell-utils.js";
import {
  getProcessSupervisor,
  type ManagedRun,
  type RunExit,
} from "../process/supervisor/index.js";
import {
  type SandboxBoundary,
  resolveCwd,
  buildSafeEnv,
  validateCommand,
  BLOCKED_ENV_KEYS,
} from "./sandbox/config.js";
import type { VibeboxExecutor } from "./sandbox/vibebox-executor.js";

// List of dangerous host environment variable names (uppercase)
const DANGEROUS_HOST_ENV_VAR_NAMES = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  "_",
]);

/**
 * Sanitize inherited host env before merge so dangerous variables from process.env
 * are not propagated into non-sandboxed executions.
 */
export function sanitizeHostBaseEnv(env: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const upperKey = key.toUpperCase();
    if (upperKey === "PATH") {
      sanitized[key] = value;
      continue;
    }
    if (isDangerousHostEnvVarName(upperKey)) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

/**
 * Check if an environment variable name is dangerous (should not be inherited from host).
 */
function isDangerousHostEnvVarName(name: string): boolean {
  return DANGEROUS_HOST_ENV_VAR_NAMES.has(name) || BLOCKED_ENV_KEYS.has(name);
}

/**
 * Centralized sanitization helper.
 * Throws an error if dangerous variables or PATH modifications are detected on the host.
 */
export function validateHostEnv(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    const upperKey = key.toUpperCase();

    // 1. Block known dangerous variables (Fail Closed)
    if (isDangerousHostEnvVarName(upperKey)) {
      throw new Error(
        `Security Violation: Environment variable '${key}' is forbidden during host execution.`,
      );
    }

    // 2. Strictly block PATH modification on host
    // Allowing custom PATH on the gateway/node can lead to binary hijacking.
    if (upperKey === "PATH") {
      throw new Error(
        "Security Violation: Custom 'PATH' variable is forbidden during host execution.",
      );
    }
  }
}

export type AuthResolver = {
  getValue: (params: {
    name: string;
    agentId: string;
    scope?: { type: "global" } | { type: "agent"; agentId: string };
  }) => Promise<string | null>;
};

export type ExecRequest = {
  argv: string[]; // true argv to execute (first-class citizen)
  rawCommand?: string; // display/approval text (optional, must be consistent with argv)
  shellCommand?: string; // resolved shell wrapper payload when command runs in shell context
  cwd?: string;
  env?: Record<string, string>;
  authRefs?: string[];
  agentId: string;
  sessionKey: string;
  // Execution mode
  yieldMs?: number;
  background?: boolean;
  pty?: boolean;
  timeoutSec?: number;
};

export type ExecResult =
  | { type: "completed"; stdout: string; stderr: string; exitCode: number }
  | { type: "backgrounded"; jobId: string; pid: number; message: string }
  | { type: "yielded"; jobId: string; pid: number; output: string; message: string }
  | { type: "error"; message: string };

export type ExecUpdateCallback = (update: {
  stdout: string;
  stderr: string;
  combined: string;
}) => void;

function escapeArgForPosixShell(arg: string): string {
  if (arg.length === 0) {
    return "''";
  }
  if (/^[A-Za-z0-9_/:.,=@%+-]+$/.test(arg)) {
    return arg;
  }
  const escaped = arg.replace(/'/g, `'"'"'`);
  return `'${escaped}'`;
}

function escapeArgForPowerShell(arg: string): string {
  if (arg.length === 0) {
    return "''";
  }
  if (/^[A-Za-z0-9_/:.,=@%+-]+$/.test(arg)) {
    return arg;
  }
  const escaped = arg.replace(/'/g, "''");
  return `'${escaped}'`;
}

function buildPtyCommandFromArgv(argv: string[]): string {
  const escape = process.platform === "win32" ? escapeArgForPowerShell : escapeArgForPosixShell;
  return argv.map(escape).join(" ");
}

export class ExecRuntime {
  private allowedSecrets: Set<string>;

  constructor(
    private registry: ProcessRegistry,
    private boundary: SandboxBoundary,
    private authResolver?: AuthResolver,
    allowedSecrets?: string[],
    private vibeboxExecutor?: VibeboxExecutor,
  ) {
    this.allowedSecrets = new Set((allowedSecrets ?? []).map((s) => s.trim().toUpperCase()));
  }

  async execute(request: ExecRequest, onUpdate?: ExecUpdateCallback): Promise<ExecResult> {
    // 0. Resolve and validate argv via resolveSystemRunCommand (consistency check)
    const resolved = resolveSystemRunCommand({
      command: request.argv,
      rawCommand: request.rawCommand ?? null,
    });
    if (!resolved.ok) {
      return { type: "error", message: resolved.message };
    }

    const resolvedRequest: ExecRequest = {
      ...request,
      argv: resolved.argv,
      rawCommand: resolved.rawCommand ?? undefined,
      shellCommand: resolved.shellCommand ?? undefined,
    };

    // 1. Validate command against allowlist
    // Use argv[0] (the actual binary) for allowlist validation.
    // When it's a shell wrapper, argv[0] is the shell name (e.g. "bash");
    // the inline shellCommand is only for display/approval purposes.
    const cmdForValidation = resolvedRequest.argv[0] ?? "";
    const cmdValidation = validateCommand(cmdForValidation, this.boundary.allowlist);
    if (!cmdValidation.ok) {
      return { type: "error", message: cmdValidation.reason };
    }

    // 2. Check protected secrets in env
    const protectedKeys = this.blockProtectedSecretsInEnv(request.env);
    if (protectedKeys.length > 0) {
      return {
        type: "error",
        message: `Protected auth env vars not allowed: ${protectedKeys.join(", ")}. Use authRefs.`,
      };
    }

    // 3. Resolve cwd
    let resolvedCwd: string;
    try {
      resolvedCwd = resolveCwd(this.boundary, request.cwd);
    } catch (err) {
      return {
        type: "error",
        message: err instanceof Error ? err.message : "cwd validation failed",
      };
    }

    // 4. Resolve auth
    let resolvedAuth: Record<string, string> = {};
    if (request.authRefs && request.authRefs.length > 0) {
      const authResult = await this.resolveAuth(request.authRefs, request.agentId);
      if (authResult.error) {
        return { type: "error", message: authResult.error };
      }
      resolvedAuth = authResult.resolved;
    }

    // 5. Build safe env
    let env: Record<string, string>;
    try {
      env = buildSafeEnv(this.boundary, { ...request.env, ...resolvedAuth });
    } catch (err) {
      return {
        type: "error",
        message: err instanceof Error ? err.message : "env validation failed",
      };
    }

    // 6. Vibebox mode
    if (this.boundary.mode === "vibebox") {
      if (!this.vibeboxExecutor) {
        return { type: "error", message: "Vibebox mode requires a VibeboxExecutor instance." };
      }
      if (request.background || request.yieldMs !== undefined) {
        return {
          type: "error",
          message:
            "Background and yield execution modes are not supported in vibebox sandbox mode.",
        };
      }
      return this.executeVibebox(resolvedRequest, resolvedCwd, env);
    }

    if (request.background || request.yieldMs !== undefined) {
      return this.executeBackground(resolvedRequest, resolvedCwd, env, onUpdate);
    }

    return this.executeOneShot(resolvedRequest, resolvedCwd, env, onUpdate);
  }

  private async executeOneShot(
    request: ExecRequest,
    cwd: string,
    env: Record<string, string>,
    onUpdate?: ExecUpdateCallback,
  ): Promise<ExecResult> {
    const jobId = this.generateJobId();
    const cmdDisplay = formatExecCommand(request.argv);

    this.registry.addSession({
      id: jobId,
      sessionId: request.sessionKey,
      agentId: request.agentId,
      command: cmdDisplay,
      cwd,
      backgrounded: false,
      pty: request.pty ?? false,
    });

    const resolvedCommand = resolveCommand(request.argv[0] ?? "");
    const parsedArgs = request.argv.slice(1);
    let stdoutBuf = "";
    let stderrBuf = "";

    let managedRun: ManagedRun;
    const spawnBase = {
      runId: jobId,
      sessionId: request.sessionKey,
      backendId: "exec-host",
      cwd,
      env,
      timeoutMs: (request.timeoutSec ?? 120) * 1000,
      captureOutput: false,
      onStdout: (chunk: string) => {
        const cleaned = sanitizeBinaryOutput(chunk);
        stdoutBuf += cleaned;
        this.registry.appendOutput(jobId, cleaned);
        onUpdate?.({ stdout: cleaned, stderr: "", combined: cleaned });
      },
      onStderr: (chunk: string) => {
        const cleaned = sanitizeBinaryOutput(chunk);
        stderrBuf += cleaned;
        this.registry.appendOutput(jobId, cleaned);
        onUpdate?.({ stdout: "", stderr: cleaned, combined: cleaned });
      },
    };

    let usingPty = request.pty ?? false;
    let ptyWarning: string | undefined;

    try {
      if (usingPty) {
        try {
          managedRun = await getProcessSupervisor().spawn({
            ...spawnBase,
            mode: "pty",
            ptyCommand: request.shellCommand ?? buildPtyCommandFromArgv(request.argv),
          });
        } catch (ptyErr) {
          // PTY spawn failed, fallback to child mode
          logger.warn(
            { err: ptyErr, argv: request.argv },
            "exec: PTY spawn failed; retrying without PTY",
          );
          ptyWarning = `Warning: PTY spawn failed (${ptyErr instanceof Error ? ptyErr.message : String(ptyErr)}); retrying without PTY for \`${cmdDisplay}\`.`;
          usingPty = false;
          managedRun = await getProcessSupervisor().spawn({
            ...spawnBase,
            mode: "child",
            argv: [resolvedCommand, ...parsedArgs],
            stdinMode: "pipe-closed",
          });
        }
      } else {
        managedRun = await getProcessSupervisor().spawn({
          ...spawnBase,
          mode: "child",
          argv: [resolvedCommand, ...parsedArgs],
          stdinMode: "pipe-closed",
        });
      }
    } catch (err) {
      this.registry.markExited({ id: jobId, exitCode: null, signal: "ERROR" });
      return { type: "error", message: err instanceof Error ? err.message : String(err) };
    }

    const exit = await managedRun.wait();
    this.registry.markExited({
      id: jobId,
      exitCode: exit.exitCode,
      signal: exit.exitSignal != null ? String(exit.exitSignal) : null,
    });

    return this.exitToCompleted(exit, stdoutBuf, stderrBuf, ptyWarning);
  }

  private async executeVibebox(
    request: ExecRequest,
    cwd: string,
    env: Record<string, string>,
  ): Promise<ExecResult> {
    try {
      const result = await this.vibeboxExecutor!.exec({
        sessionKey: request.sessionKey,
        agentId: request.agentId,
        workspaceDir: this.boundary.workspaceDir,
        command: formatExecCommand(request.argv),
        cwd,
        env,
      });
      return {
        type: "completed",
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    } catch (err) {
      return {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async executeBackground(
    request: ExecRequest,
    cwd: string,
    env: Record<string, string>,
    onUpdate?: ExecUpdateCallback,
  ): Promise<ExecResult> {
    const jobId = this.generateJobId();
    const cmdDisplay = formatExecCommand(request.argv);

    this.registry.addSession({
      id: jobId,
      sessionId: request.sessionKey,
      agentId: request.agentId,
      command: cmdDisplay,
      cwd,
      backgrounded: true,
      pty: request.pty ?? false,
    });

    const resolvedCommand = resolveCommand(request.argv[0] ?? "");
    const parsedArgs = request.argv.slice(1);
    let outputBuf = "";

    const spawnBase = {
      runId: jobId,
      sessionId: request.sessionKey,
      backendId: "exec-host",
      cwd,
      env,
      timeoutMs: request.timeoutSec ? request.timeoutSec * 1000 : undefined,
      captureOutput: false,
      onStdout: (chunk: string) => {
        const cleaned = sanitizeBinaryOutput(chunk);
        outputBuf += cleaned;
        this.registry.appendOutput(jobId, cleaned);
        onUpdate?.({ stdout: cleaned, stderr: "", combined: cleaned });
      },
      onStderr: (chunk: string) => {
        const cleaned = sanitizeBinaryOutput(chunk);
        outputBuf += cleaned;
        this.registry.appendOutput(jobId, cleaned);
        onUpdate?.({ stdout: "", stderr: cleaned, combined: cleaned });
      },
    };

    let managedRun: ManagedRun;
    let usingPty = request.pty ?? false;
    let ptyWarning: string | undefined;

    try {
      if (usingPty) {
        try {
          managedRun = await getProcessSupervisor().spawn({
            ...spawnBase,
            mode: "pty",
            ptyCommand: request.shellCommand ?? buildPtyCommandFromArgv(request.argv),
          });
        } catch (ptyErr) {
          // PTY spawn failed, fallback to child mode
          logger.warn(
            { err: ptyErr, argv: request.argv },
            "exec: PTY spawn failed; retrying without PTY",
          );
          ptyWarning = `Warning: PTY spawn failed (${ptyErr instanceof Error ? ptyErr.message : String(ptyErr)}); retrying without PTY for \`${cmdDisplay}\`.`;
          usingPty = false;
          managedRun = await getProcessSupervisor().spawn({
            ...spawnBase,
            mode: "child",
            argv: [resolvedCommand, ...parsedArgs],
            stdinMode: "pipe-open",
          });
        }
      } else {
        managedRun = await getProcessSupervisor().spawn({
          ...spawnBase,
          mode: "child",
          argv: [resolvedCommand, ...parsedArgs],
          stdinMode: "pipe-open",
        });
      }
    } catch (err) {
      this.registry.markExited({ id: jobId, exitCode: null, signal: "ERROR" });
      return { type: "error", message: err instanceof Error ? err.message : String(err) };
    }

    // Wire up exit to registry
    managedRun
      .wait()
      .then((exit) => {
        this.registry.markExited({
          id: jobId,
          exitCode: exit.exitCode,
          signal: exit.exitSignal != null ? String(exit.exitSignal) : null,
        });
      })
      .catch(() => {
        this.registry.markExited({ id: jobId, exitCode: null, signal: "ERROR" });
      });

    // Immediate background
    if (request.background === true) {
      this.registry.markBackgrounded(jobId);
      return {
        type: "backgrounded",
        jobId,
        pid: managedRun.pid ?? -1,
        message: `Process started in background (jobId: ${jobId}, pid: ${managedRun.pid ?? "unknown"}).`,
      };
    }

    // yieldMs mode: wait N ms, then background
    const yieldMs = this.clampYieldMs(request.yieldMs);
    return new Promise<ExecResult>((resolve) => {
      let resolved = false;

      const timer = setTimeout(() => {
        if (resolved) {
          return;
        }
        resolved = true;
        this.registry.markBackgrounded(jobId);
        resolve({
          type: "yielded",
          jobId,
          pid: managedRun.pid ?? -1,
          output: outputBuf,
          message: `Process still running after ${yieldMs}ms, continuing in background (jobId: ${jobId}).`,
        });
      }, yieldMs);

      managedRun
        .wait()
        .then((exit) => {
          if (resolved) {
            return;
          }
          resolved = true;
          clearTimeout(timer);
          resolve(this.exitToCompleted(exit, outputBuf, "", ptyWarning));
        })
        .catch(() => {
          if (resolved) {
            return;
          }
          resolved = true;
          clearTimeout(timer);
          resolve({ type: "error", message: "Process failed unexpectedly" });
        });
    });
  }

  private exitToCompleted(
    exit: RunExit,
    stdout: string,
    stderr: string,
    ptyWarning?: string,
  ): ExecResult {
    const exitCode = exit.exitCode ?? (exit.timedOut ? 124 : exit.exitSignal != null ? 128 : 1);

    // Shell exit codes 126 (not executable) and 127 (command not found) are
    // unrecoverable infrastructure failures that should surface as real errors
    // rather than silently completing - e.g. `python: command not found`.
    const isShellFailure = exitCode === 126 || exitCode === 127;

    // Prepend PTY warning to stdout if present
    const outputWithWarning = ptyWarning ? `${ptyWarning}\n\n${stdout}` : stdout;

    // Combine stdout and stderr for error reporting
    const combinedOutput = stderr ? `${outputWithWarning}\n${stderr}` : outputWithWarning;

    if (isShellFailure) {
      const reason =
        exitCode === 127 ? "Command not found" : "Command not executable (permission denied)";
      return {
        type: "error",
        message: combinedOutput ? `${combinedOutput}\n\n${reason}` : reason,
      };
    }

    return {
      type: "completed",
      stdout: outputWithWarning,
      stderr,
      exitCode,
    };
  }

  private generateJobId(): string {
    return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private clampYieldMs(value?: number): number {
    const MIN = 10;
    const MAX = 120_000;
    const DEFAULT = 10_000;
    if (value === undefined) {
      return DEFAULT;
    }
    if (!Number.isFinite(value) || value < MIN) {
      return MIN;
    }
    return Math.min(value, MAX);
  }

  private blockProtectedSecretsInEnv(env?: Record<string, string>): string[] {
    if (!env) {
      return [];
    }
    const re = /^[A-Z][A-Z0-9_]*_API_KEY$/;
    return Object.keys(env).filter((key) => re.test(key));
  }

  private async resolveAuth(
    authRefs: string[],
    agentId: string,
  ): Promise<{ resolved: Record<string, string>; error?: string }> {
    const refs = authRefs.map((r) => r.trim().toUpperCase()).filter((r) => r.length > 0);

    if (refs.length === 0) {
      return { resolved: {} };
    }

    if (!this.authResolver) {
      return { resolved: {}, error: "Auth broker is disabled for this runtime." };
    }

    const denied = refs.filter((name) => !this.allowedSecrets.has(name));
    if (denied.length > 0) {
      return { resolved: {}, error: `Secret(s) not allowed: ${denied.join(", ")}` };
    }

    const resolved: Record<string, string> = {};
    for (const ref of refs) {
      const value = await this.authResolver.getValue({ name: ref, agentId });
      if (!value) {
        return { resolved: {}, error: `AUTH_MISSING ${ref}` };
      }
      resolved[ref] = value;
    }

    return { resolved };
  }
}
