import type { SandboxConfig } from "./types";
import { hostExec } from "./host-exec";
import { SandboxService, type SandboxExecParams } from "./service";
import { VibeboxExecutor } from "./vibebox-executor";

export type SandboxExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type SandboxProbeResult = {
  ok: boolean;
  mode: "off" | "docker" | "apple-vm";
  message: string;
  hints: string[];
};

export interface SandboxExecutor {
  exec(params: SandboxExecParams): Promise<SandboxExecResult>;
  stop(sessionKey: string, agentId: string): Promise<void>;
  probe(): Promise<SandboxProbeResult>;
}

class HostSandboxExecutor implements SandboxExecutor {
  constructor(private allowlist?: string[]) {}

  async exec(params: SandboxExecParams): Promise<SandboxExecResult> {
    return hostExec({
      workspaceDir: params.workspaceDir,
      command: params.command,
      cwd: params.cwd,
      env: params.env,
      allowlist: this.allowlist,
    });
  }

  async stop(_sessionKey: string, _agentId: string): Promise<void> {
    return;
  }

  async probe(): Promise<SandboxProbeResult> {
    return {
      ok: true,
      mode: "off",
      message: "Sandbox mode is off; host exec is active.",
      hints: [],
    };
  }
}

export function createSandboxExecutor(params: {
  config?: SandboxConfig;
  allowlist?: string[];
}): SandboxExecutor {
  const mode = params.config?.mode ?? "off";
  if (shouldUseVibebox(params.config)) {
    return new VibeboxExecutor({
      config: params.config?.apple?.vibebox,
      defaultProvider: mode,
    });
  }
  if (mode === "docker" || mode === "apple-vm") {
    return new SandboxService(params.config);
  }
  return new HostSandboxExecutor(params.allowlist);
}

export function buildSandboxExecutorCacheKey(params: {
  config?: SandboxConfig;
  allowlist?: string[];
}): string {
  const mode = params.config?.mode ?? "off";
  if (shouldUseVibebox(params.config)) {
    return JSON.stringify({ mode, vibebox: params.config?.apple?.vibebox ?? {} });
  }
  if (mode === "docker" || mode === "apple-vm") {
    return JSON.stringify({ mode, config: params.config });
  }
  return JSON.stringify({ mode: "off", allowlist: params.allowlist ?? [] });
}

function shouldUseVibebox(config?: SandboxConfig): boolean {
  if (!config) {
    return false;
  }
  const backend = config.apple?.backend;
  if (backend === "vibebox") {
    return true;
  }
  return config.apple?.vibebox?.enabled === true;
}
