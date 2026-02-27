import { ProcessSupervisor, type ProcessOutcomeWithOutput } from "../process/supervisor.js";
import { type ProcessRegistry } from "../process/process-registry.js";
import { type SandboxBoundary, resolveCwd, buildSafeEnv, validateCommand } from "./sandbox/config.js";
import { ManagedRun } from "../process/managed-run.js";
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

export class ExecRuntime {
  private allowedSecrets: Set<string>;

  constructor(
    private supervisor: ProcessSupervisor,
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

  async execute(request: ExecRequest): Promise<ExecResult> {
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

    // 6. Determine execution mode
    const isBackground = request.background === true;
    const hasYield = request.yieldMs !== undefined;

    // 7. Delegate to VibeboxExecutor when boundary is in vibebox mode.
    // Vibebox is a one-shot bridge to an external sandbox; background/yield are
    // not supported and will return a clear error.
    if (this.boundary.mode === "vibebox") {
      if (!this.vibeboxExecutor) {
        return { type: "error", message: "Vibebox mode requires a VibeboxExecutor instance." };
      }
      if (isBackground || hasYield) {
        return {
          type: "error",
          message: "Background and yield execution modes are not supported in vibebox sandbox mode.",
        };
      }
      return this.executeVibebox(request, resolvedCwd, env);
    }

    if (isBackground || hasYield) {
      return this.executeBackground(request, resolvedCwd, env);
    }

    // 8. One-shot execution via supervisor
    return this.executeOneShot(request, resolvedCwd, env);
  }

  // One-shot: use supervisor with waitForExit
  private async executeOneShot(request: ExecRequest, cwd: string, env: Record<string, string>): Promise<ExecResult> {
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

    const handle = this.supervisor.start({
      id: jobId,
      command: "/bin/sh",
      args: ["-lc", request.command],
      cwd,
      env,
      pty: request.pty ?? false,
      timeoutSec: request.timeoutSec ?? 120,
      waitForExit: true,
    });

    const outcome = await handle.promise as ProcessOutcomeWithOutput;

    if (outcome.type === "exited") {
      return {
        type: "completed",
        stdout: outcome.stdout ?? "",
        stderr: outcome.stderr ?? "",
        exitCode: outcome.exitCode,
      };
    }

    if (outcome.type === "error") {
      return { type: "error", message: outcome.error };
    }

    // timeout or signal
    return {
      type: "completed",
      stdout: outcome.stdout ?? "",
      stderr: outcome.stderr ?? "",
      exitCode: outcome.type === "timeout" ? 124 : 128,
    };
  }

  // Vibebox one-shot: delegate to external vibebox binary bridge.
  // Auth-resolved env is passed through; PTU/timeout are not forwarded since
  // the vibebox binary has its own timeout config.
  private async executeVibebox(request: ExecRequest, cwd: string, env: Record<string, string>): Promise<ExecResult> {
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

  // Background / yield execution
  private executeBackground(request: ExecRequest, cwd: string, env: Record<string, string>): ExecResult | Promise<ExecResult> {
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

    const handle = this.supervisor.start({
      id: jobId,
      command: request.command,
      cwd,
      env,
      pty: request.pty ?? false,
      timeoutSec: request.timeoutSec,
    });

    const managedRun = new ManagedRun(handle);

    // Immediate background
    if (request.background === true) {
      this.registry.markBackgrounded(jobId);
      return {
        type: "backgrounded",
        jobId,
        pid: handle.pid,
        message: `Process started in background (jobId: ${jobId}, pid: ${handle.pid}).`,
      };
    }

    // yieldMs mode
    const yieldMs = this.clampYieldMs(request.yieldMs);
    return new Promise<ExecResult>((resolve) => {
      const timer = setTimeout(() => {
        this.registry.markBackgrounded(jobId);
        resolve({
          type: "yielded",
          jobId,
          pid: handle.pid,
          output: managedRun.getOutput(),
          message: `Process still running after ${yieldMs}ms, continuing in background (jobId: ${jobId}).`,
        });
      }, yieldMs);

      managedRun.promise.then((outcome) => {
        clearTimeout(timer);
        const output = managedRun.getOutput();
        resolve({
          type: "completed",
          stdout: output,
          stderr: "",
          exitCode: outcome.exitCode ?? (outcome.reason === "timeout" ? 124 : 128),
        });
      });
    });
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
