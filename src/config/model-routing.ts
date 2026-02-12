import type { MoziConfig } from "./schema";

export type AgentModelList = {
  primary?: string;
  fallbacks: string[];
  hasPrimary: boolean;
  hasFallbacks: boolean;
};

export type AgentModelRouting = {
  defaultModel: AgentModelList;
  imageModel: AgentModelList;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toModelList(raw: unknown): AgentModelList {
  if (typeof raw === "string") {
    return { primary: raw, fallbacks: [], hasPrimary: true, hasFallbacks: false };
  }
  if (!isRecord(raw)) {
    return { fallbacks: [], hasPrimary: false, hasFallbacks: false };
  }
  const hasPrimary = Object.hasOwn(raw, "primary");
  const hasFallbacks = Object.hasOwn(raw, "fallbacks");
  const primary = typeof raw.primary === "string" ? raw.primary : undefined;
  const fallbacks = Array.isArray(raw.fallbacks)
    ? raw.fallbacks.filter((item): item is string => typeof item === "string")
    : [];
  return { primary, fallbacks, hasPrimary, hasFallbacks };
}

function pickEntry(
  agents: MoziConfig["agents"],
  agentId: string,
): Record<string, unknown> | undefined {
  if (!agents) {
    return undefined;
  }
  const value = (agents as Record<string, unknown>)[agentId];
  return isRecord(value) ? value : undefined;
}

function merge(primary?: AgentModelList, fallback?: AgentModelList): AgentModelList {
  return {
    primary: primary?.hasPrimary ? primary.primary : fallback?.primary,
    fallbacks: primary?.hasFallbacks ? primary.fallbacks : (fallback?.fallbacks ?? []),
    hasPrimary: primary?.hasPrimary ?? fallback?.hasPrimary ?? false,
    hasFallbacks: primary?.hasFallbacks ?? fallback?.hasFallbacks ?? false,
  };
}

export function resolveAgentModelRouting(config: MoziConfig, agentId: string): AgentModelRouting {
  const defaults = pickEntry(config.agents, "defaults");
  const entry = pickEntry(config.agents, agentId);

  const defaultModel = merge(toModelList(entry?.model), toModelList(defaults?.model));
  const imageModel = merge(toModelList(entry?.imageModel), toModelList(defaults?.imageModel));

  return {
    defaultModel,
    imageModel,
  };
}
