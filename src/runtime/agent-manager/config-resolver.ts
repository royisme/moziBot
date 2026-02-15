import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import path from "node:path";
import type { MoziConfig } from "../../config";
import type { SandboxConfig } from "../sandbox/types";
import type { ContextPruningConfig } from "../context-pruning";
import { resolveToolAllowList as resolveToolAllowListCore } from "../tool-selection";
import { resolveHistoryLimitFromSessionKey } from "../context-management";

export type AgentEntry = {
  name?: string;
  main?: boolean;
  home?: string;
  workspace?: string;
  systemPrompt?: string;
  model?: unknown;
  imageModel?: unknown;
  skills?: string[];
  tools?: string[];
  subagents?: { allow?: string[] };
  sandbox?: unknown;
  exec?: { allowlist?: string[]; allowedSecrets?: string[] };
  heartbeat?: { enabled?: boolean; every?: string; prompt?: string };
  thinking?: ThinkingLevel;
  output?: {
    showThinking?: boolean;
    showToolCalls?: "off" | "summary";
  };
  lifecycle?: {
    control?: {
      model?: string;
      fallback?: string[];
    };
  };
  metadata?: {
    thinkingLevel?: ThinkingLevel | null;
  };
  timeoutSeconds?: number;
  contextPruning?: ContextPruningConfig;
};

export const DEFAULT_TOOL_NAMES = [
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "memory_search",
  "memory_get",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "schedule_continuation",
  "reminder_create",
  "reminder_list",
  "reminder_cancel",
  "reminder_update",
  "reminder_snooze",
  "subagent_run",
  "skills_note",
  "exec",
];

export function resolveWorkspaceDir(
  config: MoziConfig,
  agentId: string,
  entry?: AgentEntry,
): string {
  if (entry?.workspace) {
    return entry.workspace;
  }
  const baseDir = config.paths?.baseDir;
  if (baseDir) {
    return path.join(baseDir, "agents", agentId, "workspace");
  }
  return path.join("./workspace", agentId);
}

export function resolveHomeDir(
  config: MoziConfig,
  agentId: string,
  entry?: AgentEntry,
): string {
  if (entry?.home) {
    return entry.home;
  }
  const baseDir = config.paths?.baseDir;
  if (baseDir) {
    return path.join(baseDir, "agents", agentId, "home");
  }
  return path.join(".", "agents", agentId, "home");
}

export function resolveSandboxConfig(
  config: MoziConfig,
  entry?: AgentEntry,
): SandboxConfig | undefined {
  const defaults = (config.agents?.defaults as { sandbox?: SandboxConfig } | undefined)?.sandbox;
  const override = entry?.sandbox as SandboxConfig | undefined;
  if (!defaults && !override) {
    return undefined;
  }
  return {
    ...defaults,
    ...override,
    docker: { ...defaults?.docker, ...override?.docker },
    apple: { ...defaults?.apple, ...override?.apple },
  };
}

export function resolveExecAllowlist(
  config: MoziConfig,
  entry?: AgentEntry,
): string[] | undefined {
  const defaults = (
    config.agents?.defaults as { exec?: { allowlist?: string[] } } | undefined
  )?.exec;
  return entry?.exec?.allowlist ?? defaults?.allowlist;
}

export function resolveExecAllowedSecrets(
  config: MoziConfig,
  entry?: AgentEntry,
): string[] {
  const defaults = (
    config.agents?.defaults as { exec?: { allowedSecrets?: string[] } } | undefined
  )?.exec;
  return entry?.exec?.allowedSecrets ?? defaults?.allowedSecrets ?? [];
}

export function resolveToolAllowList(
  config: MoziConfig,
  entry?: AgentEntry,
): string[] {
  const defaults = (config.agents?.defaults as { tools?: string[] } | undefined)?.tools;
  return resolveToolAllowListCore({
    agentTools: entry?.tools,
    defaultTools: defaults,
    fallbackTools: DEFAULT_TOOL_NAMES,
    requiredTools: ["exec"],
  });
}

export function resolveContextPruningConfig(
  config: MoziConfig,
  entry?: AgentEntry,
): ContextPruningConfig | undefined {
  const defaults = (
    config.agents?.defaults as { contextPruning?: ContextPruningConfig } | undefined
  )?.contextPruning;
  const agentConfig = (entry as { contextPruning?: ContextPruningConfig } | undefined)
    ?.contextPruning;
  if (!defaults && !agentConfig) {
    return undefined;
  }
  return { ...defaults, ...agentConfig };
}

export function resolveHistoryLimit(
  config: MoziConfig,
  sessionKey: string,
): number | undefined {
  const channelMatch = sessionKey.match(/^agent:[^:]+:([^:]+):/);
  const channelId = channelMatch?.[1];
  if (!channelId) {
    return undefined;
  }
  const channelConfig = (
    config.channels as
      | Record<
          string,
          {
            dmHistoryLimit?: number;
            dms?: Record<string, { historyLimit?: number }>;
          }
        >
      | undefined
  )?.[channelId];
  return resolveHistoryLimitFromSessionKey(sessionKey, channelConfig);
}

export function resolvePromptTimeoutMs(
  config: MoziConfig,
  entry?: AgentEntry,
): number {
  const perAgent = entry?.timeoutSeconds;
  const defaults =
    (config.agents?.defaults as { timeoutSeconds?: number } | undefined)?.timeoutSeconds;
  return (perAgent ?? defaults ?? 300) * 1000;
}
