import type { MoziConfig } from "../../config";
import { loadConfig } from "../../config";
import { ModelRegistry } from "../../runtime/model-registry";
import { ProviderRegistry } from "../../runtime/provider-registry";
import { bootstrapSandboxes } from "../../runtime/sandbox/bootstrap";

export async function validateConfig(configPath?: string) {
  const result = loadConfig(configPath);
  if (result.success) {
    console.log("✅ Configuration is valid.");
    return;
  }
  console.error("❌ Configuration is invalid:");
  for (const error of result.errors ?? []) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

export async function doctorConfig(configPath?: string, options: { fix?: boolean } = {}) {
  const result = loadConfig(configPath);
  if (!result.success || !result.config) {
    console.error("❌ Configuration is invalid:");
    for (const error of result.errors ?? []) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  const config = result.config;
  const errors: string[] = [];
  const warnings: string[] = [];

  const agentEntries = listAgentEntries(config);
  if (agentEntries.length === 0) {
    errors.push("No agents configured. Add at least one agent entry under agents.");
  }

  const modelRegistry = new ModelRegistry(config);
  const providerRegistry = new ProviderRegistry(config);

  for (const { id, entry } of agentEntries) {
    const modelRef = resolveAgentModelRef(config, entry);
    if (!modelRef) {
      errors.push(`Agent ${id} has no model configured.`);
      continue;
    }
    const spec = modelRegistry.get(modelRef);
    if (!spec) {
      errors.push(`Agent ${id} references unknown model: ${modelRef}`);
      continue;
    }
    const apiKey = providerRegistry.resolveApiKey(spec.provider);
    if (!apiKey) {
      warnings.push(`Provider ${spec.provider} has no API key (agent ${id}).`);
    }
  }

  const channels = config.channels ?? {};
  const telegram = channels.telegram;
  if (telegram?.enabled && !telegram.botToken) {
    errors.push("Telegram is enabled but botToken is missing.");
  }
  const discord = channels.discord;
  if (discord?.enabled && !discord.botToken) {
    errors.push("Discord is enabled but botToken is missing.");
  }

  for (const agentId of referencedAgents(channels)) {
    if (!agentEntries.some((entry) => entry.id === agentId)) {
      errors.push(`Channel references unknown agent: ${agentId}`);
    }
  }

  const heartbeatIssues = validateHeartbeat(config, agentEntries);
  errors.push(...heartbeatIssues.errors);
  warnings.push(...heartbeatIssues.warnings);

  if (options.fix) {
    if (errors.length > 0) {
      warnings.push("Skipping sandbox bootstrap because blocking config issues exist.");
    } else {
      const bootstrap = await bootstrapSandboxes(config, { fix: true });
      for (const action of bootstrap.actions) {
        console.log(`🔧 [${action.agentId}] ${action.message}`);
      }
      for (const issue of bootstrap.issues) {
        const line = `[${issue.agentId}] ${issue.message}`;
        if (issue.level === "error") {
          errors.push(line);
        } else {
          warnings.push(line);
        }
        for (const hint of issue.hints) {
          warnings.push(`[${issue.agentId}] hint: ${hint}`);
        }
      }
    }
  }

  if (errors.length === 0) {
    console.log("✅ Configuration looks runnable.");
  } else {
    console.error("❌ Configuration has blocking issues:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
  }

  if (warnings.length > 0) {
    console.warn("\n⚠️ Warnings:");
    for (const warn of warnings) {
      console.warn(`- ${warn}`);
    }
  }

  if (errors.length > 0) {
    process.exit(1);
  }
}

type AgentEntry = {
  id: string;
  entry: {
    model?: unknown;
    heartbeat?: { enabled?: boolean; every?: string; prompt?: string };
  };
};

type ModelConfig = {
  primary?: string;
  fallbacks?: string[];
};

function listAgentEntries(config: MoziConfig): AgentEntry[] {
  const agents = config.agents || {};
  return Object.entries(agents)
    .filter(([key]) => key !== "defaults")
    .map(([id, entry]) => ({ id, entry: entry as AgentEntry["entry"] }));
}

function normalizeModelConfig(raw: unknown): ModelConfig | undefined {
  if (!raw) {
    return undefined;
  }
  if (typeof raw === "string") {
    return { primary: raw };
  }
  if (typeof raw === "object") {
    const primary = (raw as { primary?: string }).primary;
    const fallbacks = (raw as { fallbacks?: string[] }).fallbacks;
    return { primary, fallbacks };
  }
  return undefined;
}

function resolveAgentModelRef(config: MoziConfig, entry: AgentEntry["entry"]): string | undefined {
  const modelCfg = normalizeModelConfig(entry.model);
  if (modelCfg?.primary) {
    return modelCfg.primary;
  }
  const defaults = normalizeModelConfig(config.agents?.defaults?.model);
  return defaults?.primary;
}

function referencedAgents(channels: MoziConfig["channels"]): string[] {
  const ids: string[] = [];
  if (channels?.telegram?.agentId) {
    ids.push(channels.telegram.agentId);
  }
  if (channels?.telegram?.agent) {
    ids.push(channels.telegram.agent);
  }
  if (channels?.discord?.agentId) {
    ids.push(channels.discord.agentId);
  }
  if (channels?.discord?.agent) {
    ids.push(channels.discord.agent);
  }
  if (channels?.routing?.dmAgentId) {
    ids.push(channels.routing.dmAgentId);
  }
  if (channels?.routing?.dmAgent) {
    ids.push(channels.routing.dmAgent);
  }
  if (channels?.routing?.groupAgentId) {
    ids.push(channels.routing.groupAgentId);
  }
  if (channels?.routing?.groupAgent) {
    ids.push(channels.routing.groupAgent);
  }
  return Array.from(new Set(ids));
}

function validateHeartbeat(config: MoziConfig, agentEntries: AgentEntry[]) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const defaults = (
    config.agents?.defaults as { heartbeat?: { enabled?: boolean; every?: string } } | undefined
  )?.heartbeat;
  for (const { id, entry } of agentEntries) {
    const hb = entry.heartbeat ?? defaults;
    if (!hb?.enabled) {
      continue;
    }
    const every = hb.every ?? "30m";
    if (!parseEveryMs(every)) {
      errors.push(`Agent ${id} heartbeat.every is invalid: ${every}`);
    }
  }
  if (!defaults?.enabled) {
    warnings.push(
      "Heartbeat defaults are disabled. No periodic checks will run unless enabled per agent.",
    );
  }
  return { errors, warnings };
}

function parseEveryMs(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (!value) {
    return null;
  }
  const match = /^([0-9]+)\s*(ms|s|m|h|d)$/.exec(value);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const unit = match[2];
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return amount * (multipliers[unit] || 0);
}
