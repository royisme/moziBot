import { type ProcessRegistry } from "../process/process-registry.js";
import { type SandboxBoundary, resolveCwd, buildSafeEnv, validateCommand } from "./sandbox/config.js";
import { getProcessSupervisor, type ManagedRun, type RunExit } from "../process/supervisor/index.js";
import { getShellConfig, sanitizeBinaryOutput } from "../process/shell-utils.js";
import type { VibeboxExecutor } from "./sandbox/vibebox-executor.js";

export type AuthResolver = {
  getValue: (params: {
    name: string;
    agentId: string;
    scope?: { type: "global" } | { type: "agent"; agentId: string };
  }) => Promise<string | null>;
};

export type ExecRequest = {
  command: string;
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

export class ExecRuntime {
  private allowedSecrets: Set<string>;

  constructor(
    private registry: ProcessRegistry,
    private boundary: SandboxBoundary,
    private authResolver?: AuthResolver,
    allowedSecrets?: string[],
    private vibeboxExecutor?: VibeboxExecutor,
  ) {
    this.allowedSecrets = new Set(
      (allowedSecrets ?? []).map(s => s.trim().toUpperCase())
    );
  }

  async execute(request: ExecRequest, onUpdate?: ExecUpdateCallback): Promise<ExecResult> {
    // 1. Validate command against allowlist
    const cmdValidation = validateCommand(request.command, this.boundary.allowlist);
    if (!cmdValidation.ok) {
      return { type: "error", message: cmdValidation.reason };
    }

    // 2. Check protected secrets in env
    const protectedKeys = this.blockProtectedSecretsInEnv(request.env);
    if (protectedKeys.length > 0) {
      return { type: "error", message: `Protected auth env vars not allowed: ${protectedKeys.join(", ")}. Use authRefs.` };
    }

    // 3. Resolve cwd
    let resolvedCwd: string;
    try {
      resolvedCwd = resolveCwd(this.boundary, request.cwd);
    } catch (err) {
      return { type: "error", message: err instanceof Error ? err.message : "cwd validation failed" };
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
      return { type: "error", message: err instanceof Error ? err.message : "env validation failed" };
    }

    // 6. Vibebox mode
    if (this.boundary.mode === "vibebox") {
      if (!this.vibeboxExecutor) {
        return { type: "error", message: "Vibebox mode requires a VibeboxExecutor instance." };
      }
      if (request.background || request.yieldMs !== undefined) {
        return {
          type: "error",
          message: "Background and yield execution modes are not supported in vibebox sandbox mode.",
        };
      }
      return this.executeVibebox(request, resolvedCwd, env);
    }

    if (request.background || request.yieldMs !== undefined) {
      return this.executeBackground(request, resolvedCwd, env, onUpdate);
    }

    return this.executeOneShot(request, resolvedCwd, env, onUpdate);
  }

  private async executeOneShot(
    request: ExecRequest,
    cwd: string,
    env: Record<string, string>,
    onUpdate?: ExecUpdateCallback,
  ): Promise<ExecResult> {
    const jobId = this.generateJobId();

    this.registry.addSession({
      id: jobId,
      sessionId: request.sessionKey,
      agentId: request.agentId,
      command: request.command,
      cwd,
      backgrounded: false,
      pty: request.pty ?? false,
    });

    const { shell, args: shellArgs } = getShellConfig();
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

    try {
      if (request.pty) {
        managedRun = await getProcessSupervisor().spawn({
          ...spawnBase,
          mode: "pty",
          ptyCommand: request.command,
        });
      } else {
        managedRun = await getProcessSupervisor().spawn({
          ...spawnBase,
          mode: "child",
          argv: [shell, ...shellArgs, request.command],
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

    return this.exitToCompleted(exit, stdoutBuf, stderrBuf);
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
        command: request.command,
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

    this.registry.addSession({
      id: jobId,
      sessionId: request.sessionKey,
      agentId: request.agentId,
      command: request.command,
      cwd,
      backgrounded: true,
      pty: request.pty ?? false,
    });

    const { shell, args: shellArgs } = getShellConfig();
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
    try {
      if (request.pty) {
        managedRun = await getProcessSupervisor().spawn({
          ...spawnBase,
          mode: "pty",
          ptyCommand: request.command,
        });
      } else {
        managedRun = await getProcessSupervisor().spawn({
          ...spawnBase,
          mode: "child",
          argv: [shell, ...shellArgs, request.command],
          stdinMode: "pipe-open",
        });
      }
    } catch (err) {
      this.registry.markExited({ id: jobId, exitCode: null, signal: "ERROR" });
      return { type: "error", message: err instanceof Error ? err.message : String(err) };
    }

    // Wire up exit to registry
    managedRun.wait().then((exit) => {
      this.registry.markExited({
        id: jobId,
        exitCode: exit.exitCode,
        signal: exit.exitSignal != null ? String(exit.exitSignal) : null,
      });
    }).catch(() => {
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
        if (resolved) return;
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

      managedRun.wait().then((exit) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve(this.exitToCompleted(exit, outputBuf, ""));
      }).catch(() => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve({ type: "error", message: "Process failed unexpectedly" });
      });
    });
  }

  private exitToCompleted(exit: RunExit, stdout: string, stderr: string): ExecResult {
    const exitCode =
      exit.exitCode ?? (exit.timedOut ? 124 : exit.exitSignal != null ? 128 : 1);
    return {
      type: "completed",
      stdout,
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
    if (value === undefined) return DEFAULT;
    if (!Number.isFinite(value) || value < MIN) return MIN;
    return Math.min(value, MAX);
  }

  private blockProtectedSecretsInEnv(env?: Record<string, string>): string[] {
    if (!env) return [];
    const re = /^[A-Z][A-Z0-9_]*_API_KEY$/;
    return Object.keys(env).filter(key => re.test(key));
  }

  private async resolveAuth(
    authRefs: string[],
    agentId: string,
  ): Promise<{ resolved: Record<string, string>; error?: string }> {
    const refs = authRefs
      .map(r => r.trim().toUpperCase())
      .filter(r => r.length > 0);

    if (refs.length === 0) return { resolved: {} };

    if (!this.authResolver) {
      return { resolved: {}, error: "Auth broker is disabled for this runtime." };
    }

    const denied = refs.filter(name => !this.allowedSecrets.has(name));
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
