import type { Mount } from "../../container/runtime";

export type SandboxBackend = "docker" | "apple";
export type SandboxMode = "off" | "apple-vm" | "docker";

export type SandboxVibeboxConfig = {
  enabled?: boolean;
  binPath?: string;
  projectRoot?: string;
  timeoutSeconds?: number;
  provider?: "off" | "apple-vm" | "docker" | "auto";
};

export type SandboxDockerConfig = {
  image?: string;
  workdir?: string;
  env?: Record<string, string>;
  network?: string;
  mounts?: string[];
};

export type SandboxAppleConfig = {
  image?: string;
  workdir?: string;
  env?: Record<string, string>;
  network?: string;
  mounts?: string[];
  backend?: "native" | "vibebox";
  vibebox?: SandboxVibeboxConfig;
};

export type SandboxConfig = {
  mode?: SandboxMode;
  autoBootstrapOnStart?: boolean;
  workspaceAccess?: "none" | "ro" | "rw";
  docker?: SandboxDockerConfig;
  apple?: SandboxAppleConfig;
};

export type SandboxMount = Mount;
