import path from "node:path";
import type { SandboxConfig } from "./types";
import { ContainerRuntime, type ContainerConfig, type Mount } from "../../container/runtime";

const DEFAULT_WORKDIR = "/workspace";

export type SandboxExecParams = {
  sessionKey: string;
  agentId: string;
  workspaceDir: string;
  command: string;
  env?: Record<string, string>;
  cwd?: string;
};

export class SandboxService {
  private runtime: ContainerRuntime;
  private containers = new Map<string, string>();
  private backend: "docker" | "apple";

  constructor(private config: SandboxConfig) {
    this.backend = resolveBackend(this.config);
    this.runtime = new ContainerRuntime(this.backend);
  }

  async exec(
    params: SandboxExecParams,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const containerName = await this.ensureContainer(params);
    const command = params.cwd
      ? ["/bin/sh", "-lc", `cd ${this.shellQuote(params.cwd)} && ${params.command}`]
      : ["/bin/sh", "-lc", params.command];
    return this.runtime.exec(containerName, command);
  }

  async stop(sessionKey: string, agentId: string): Promise<void> {
    const key = this.key(sessionKey, agentId);
    const name = this.containers.get(key);
    if (!name) {
      return;
    }
    await this.runtime.stop(name);
    await this.runtime.remove(name, true);
    this.containers.delete(key);
  }

  async probe(): Promise<{
    ok: boolean;
    mode: "docker" | "apple-vm";
    message: string;
    hints: string[];
  }> {
    const mode: "docker" | "apple-vm" = this.backend === "docker" ? "docker" : "apple-vm";
    const settings =
      this.backend === "docker" ? (this.config.docker ?? {}) : (this.config.apple ?? {});

    if (!settings.image) {
      const imageKey = this.backend === "docker" ? "docker.image" : "apple.image";
      return {
        ok: false,
        mode,
        message: `Sandbox ${mode} is not configured: missing ${imageKey}.`,
        hints: [
          `Set agents.<id>.sandbox.${imageKey} in config.jsonc.`,
          "Or set agents.defaults.sandbox and override per agent when needed.",
        ],
      };
    }

    const available = await this.runtime.isAvailable();
    if (!available) {
      return {
        ok: false,
        mode,
        message: `Sandbox runtime is unavailable for mode ${mode}.`,
        hints:
          mode === "docker"
            ? [
                "Install Docker and ensure the daemon is running.",
                "Run `docker info` to verify host runtime availability.",
              ]
            : [
                "Install Apple container runtime and ensure `container` is in PATH.",
                "Run `container info` to verify host runtime availability.",
              ],
      };
    }

    return {
      ok: true,
      mode,
      message: `Sandbox runtime is available for mode ${mode}.`,
      hints: [],
    };
  }

  private async ensureContainer(params: SandboxExecParams): Promise<string> {
    const key = this.key(params.sessionKey, params.agentId);
    const existing = this.containers.get(key);
    if (existing) {
      return existing;
    }

    const containerSettings =
      this.backend === "docker" ? (this.config.docker ?? {}) : (this.config.apple ?? {});
    if (!containerSettings.image) {
      throw new Error(`Sandbox ${this.backend} image is required`);
    }

    const containerName = this.buildContainerName(params.sessionKey, params.agentId);
    const config = buildContainerConfig({
      backend: this.backend,
      image: containerSettings.image,
      workdir: containerSettings.workdir ?? DEFAULT_WORKDIR,
      env: { ...containerSettings.env, ...params.env },
      network: containerSettings.network,
      mounts: buildMounts({
        workspaceDir: params.workspaceDir,
        workspaceAccess: this.config.workspaceAccess,
        extraMounts: containerSettings.mounts,
      }),
    });

    await this.runtime.create(containerName, config);
    this.containers.set(key, containerName);
    return containerName;
  }

  private buildContainerName(sessionKey: string, agentId: string): string {
    const safeSession = sanitizeName(sessionKey, 24);
    const safeAgent = sanitizeName(agentId, 16);
    return `mozi-sbx-${safeAgent}-${safeSession}`;
  }

  private key(sessionKey: string, agentId: string): string {
    return `${agentId}::${sessionKey}`;
  }

  private shellQuote(value: string): string {
    const escaped = value.replace(/'/g, "'\\''");
    return `'${escaped}'`;
  }
}

export function buildContainerConfig(params: {
  backend: "docker" | "apple";
  image: string;
  workdir: string;
  env?: Record<string, string>;
  network?: string;
  mounts: Mount[];
}): ContainerConfig {
  return {
    backend: params.backend,
    image: params.image,
    workdir: params.workdir,
    env: params.env,
    network: params.network,
    mounts: params.mounts,
  };
}

export function buildMounts(params: {
  workspaceDir: string;
  workspaceAccess?: "none" | "ro" | "rw";
  extraMounts?: string[];
}): Mount[] {
  const mounts: Mount[] = [];
  const access = params.workspaceAccess ?? "rw";
  if (access !== "none") {
    mounts.push({
      source: path.resolve(params.workspaceDir),
      target: DEFAULT_WORKDIR,
      readonly: access === "ro",
    });
  }

  const extra = params.extraMounts ?? [];
  for (const mount of extra) {
    const parsed = parseMountSpec(mount);
    if (parsed) {
      mounts.push(parsed);
    }
  }

  return mounts;
}

export function parseMountSpec(spec: string): Mount | null {
  const trimmed = spec.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(":");
  if (parts.length < 2) {
    return null;
  }
  const source = parts[0];
  const target = parts[1];
  const readonly = parts[2] === "ro";
  if (!source || !target) {
    return null;
  }
  return {
    source,
    target,
    readonly,
  };
}

function sanitizeName(value: string, maxLen: number): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!normalized) {
    return "default";
  }
  return normalized.slice(0, maxLen);
}

function resolveBackend(config: SandboxConfig): "docker" | "apple" {
  if (config.mode === "apple-vm") {
    return "apple";
  }
  if (config.mode === "docker") {
    return "docker";
  }
  throw new Error(`Sandbox mode is not containerized: ${config.mode ?? "off"}`);
}
