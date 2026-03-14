/**
 * Config doctor checks
 * Extracted from the original doctorConfig implementation
 */

import { CONFIG_REDACTION_SENTINEL } from "../../../config";
import type { MoziConfig } from "../../../config";
import { resolveAgentModelRouting } from "../../../config/model-routing";
import { ModelRegistry } from "../../../runtime/model-registry";
import { ProviderRegistry } from "../../../runtime/provider-registry";
import type { DoctorFinding, DoctorCheckContext } from "../types";

type AgentEntry = {
  id: string;
  entry: {
    heartbeat?: { enabled?: boolean; every?: string; prompt?: string };
  };
};

export async function runConfigChecks(
  config: MoziConfig,
  _context: DoctorCheckContext,
): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];

  // Check: agents exist
  const agentEntries = listAgentEntries(config);
  if (agentEntries.length === 0) {
    findings.push({
      id: "config:no-agents",
      level: "fail",
      summary: "No agents configured. Add at least one agent entry under agents.",
    });
  }

  const modelRegistry = new ModelRegistry(config);
  const providerRegistry = new ProviderRegistry(config);

  // Check: agent model references
  for (const { id } of agentEntries) {
    const routing = resolveAgentModelRouting(config, id);
    const modelRef = routing.defaultModel.primary;
    if (!modelRef) {
      findings.push({
        id: "config:agent-no-model",
        level: "fail",
        summary: `Agent ${id} has no model configured.`,
      });
      continue;
    }
    const spec = modelRegistry.get(modelRef);
    if (!spec) {
      findings.push({
        id: "config:unknown-model",
        level: "fail",
        summary: `Agent ${id} references unknown model: ${modelRef}`,
      });
      continue;
    }
    const apiKey = providerRegistry.resolveApiKey(spec.provider);
    if (!apiKey) {
      findings.push({
        id: "config:provider-no-apikey",
        level: "warn",
        summary: `Provider ${spec.provider} has no API key (agent ${id}).`,
        details: "The agent may fail at runtime without valid credentials.",
        fixHint: `Set the API key for provider ${spec.provider} in your config, project .env file, or shared Mozi secret storage.`,
      });
    }

    // Check image model references
    const imageRefs = [routing.imageModel.primary, ...routing.imageModel.fallbacks].filter(
      (ref): ref is string => Boolean(ref),
    );

    for (const ref of imageRefs) {
      const modSpec = modelRegistry.get(ref);
      if (!modSpec) {
        findings.push({
          id: "config:unknown-image-model",
          level: "fail",
          summary: `Agent ${id} image route references unknown model: ${ref}`,
        });
        continue;
      }
      if (!(modSpec.input ?? ["text"]).includes("image")) {
        findings.push({
          id: "config:model-no-image-capability",
          level: "warn",
          summary: `Agent ${id} image route model ${ref} does not declare image input capability.`,
          details: `Model ${ref} declares inputs: ${(modSpec.input ?? ["text"]).join(", ")}`,
        });
      }
    }
  }

  // Check: channel token presence
  const channels = config.channels ?? {};
  const telegram = channels.telegram;
  if (telegram?.enabled && !telegram.botToken) {
    findings.push({
      id: "config:telegram-no-token",
      level: "fail",
      summary: "Telegram is enabled but botToken is missing.",
    });
  }
  const discord = channels.discord;
  if (discord?.enabled && !discord.botToken) {
    findings.push({
      id: "config:discord-no-token",
      level: "fail",
      summary: "Discord is enabled but botToken is missing.",
    });
  }

  // Check: channel references valid agents
  for (const agentId of referencedAgents(channels)) {
    if (!agentEntries.some((entry) => entry.id === agentId)) {
      findings.push({
        id: "config:channel-unknown-agent",
        level: "fail",
        summary: `Channel references unknown agent: ${agentId}`,
      });
    }
  }

  // Check: heartbeat configuration
  const heartbeatFindings = validateHeartbeat(config, agentEntries);
  findings.push(...heartbeatFindings);

  // Check: secret values
  const secretFindings = checkSecretIssues(config);
  findings.push(...secretFindings);

  // Check: redaction sentinel values
  if (hasRedactedValue(config)) {
    findings.push({
      id: "config:has-redaction-sentinel",
      level: "warn",
      summary: "Config contains redaction sentinel values.",
      details:
        "Some values are still set to the redaction sentinel and need to be replaced with actual values.",
    });
  }

  // Check: extensions installs
  if (config.extensions?.installs && Object.keys(config.extensions.installs).length > 0) {
    findings.push({
      id: "config:extensions-installs-warning",
      level: "warn",
      summary:
        "extensions.installs is currently metadata only and does not auto-install extension packages.",
      details: "Extensions must be installed manually via their respective package managers.",
    });
  }

  return findings;
}

function listAgentEntries(config: MoziConfig): AgentEntry[] {
  const agents = config.agents || {};
  return Object.entries(agents)
    .filter(([key]) => key !== "defaults")
    .map(([id, entry]) => ({ id, entry: entry as AgentEntry["entry"] }));
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

function validateHeartbeat(config: MoziConfig, agentEntries: AgentEntry[]): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const defaults = (
    config.agents?.defaults as { heartbeat?: { enabled?: boolean; every?: string } } | undefined
  )?.heartbeat;
  const hasExplicitAgents = agentEntries.some((entry) => Boolean(entry.entry.heartbeat));
  const defaultAgentId = resolveDefaultAgentId(config);
  let hasEnabled = false;

  for (const { id, entry } of agentEntries) {
    if (hasExplicitAgents && !entry.heartbeat) {
      continue;
    }
    if (!hasExplicitAgents && id !== defaultAgentId) {
      continue;
    }
    const hb = entry.heartbeat ?? defaults;
    if (!hb?.enabled) {
      continue;
    }
    hasEnabled = true;
    const every = hb.every ?? "30m";
    if (!parseEveryMs(every)) {
      findings.push({
        id: "config:heartbeat-invalid-interval",
        level: "fail",
        summary: `Agent ${id} heartbeat.every is invalid: ${every}`,
        details: "The interval must be a valid duration like '30m', '1h', '5000ms'.",
        fixHint: "Set heartbeat.every to a valid duration string.",
      });
    }
  }

  if (!hasEnabled) {
    findings.push({
      id: "config:heartbeat-disabled",
      level: "warn",
      summary:
        "Heartbeat is disabled. No periodic checks will run unless enabled for at least one agent.",
      details: "Enable heartbeat for an agent to receive periodic health checks.",
    });
  }

  return findings;
}

function resolveDefaultAgentId(config: MoziConfig): string {
  const agents = config.agents ?? {};
  const entries = Object.entries(agents).filter(([id]) => id !== "defaults");
  const main = entries.find(([, entry]) => (entry as { main?: boolean }).main === true);
  if (main?.[0]) {
    return main[0];
  }
  return entries[0]?.[0] || "mozi";
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

function checkSecretIssues(config: MoziConfig): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const unresolvedEnvPattern = /^\$\{[^}]+\}$/;
  const providers = config.models?.providers ?? {};

  for (const [provider, entry] of Object.entries(providers)) {
    if (entry.apiKey === CONFIG_REDACTION_SENTINEL) {
      findings.push({
        id: "config:provider-redacted-api-key",
        level: "fail",
        summary: `Provider ${provider} apiKey is redacted sentinel and must be replaced.`,
        fixHint: `Set a valid API key for provider ${provider} in your config, project .env file, or shared Mozi secret storage.`,
      });
    }
    if (typeof entry.apiKey === "string" && unresolvedEnvPattern.test(entry.apiKey)) {
      findings.push({
        id: "config:provider-unresolved-env",
        level: "fail",
        summary: `Provider ${provider} apiKey is unresolved env placeholder.`,
        fixHint: `Ensure the environment variable referenced in ${provider}.apiKey is set.`,
      });
    }
  }

  const telegram = config.channels?.telegram;
  if (telegram?.enabled) {
    if (telegram.botToken === CONFIG_REDACTION_SENTINEL) {
      findings.push({
        id: "config:telegram-redacted-token",
        level: "fail",
        summary: "Telegram botToken is redacted sentinel and must be replaced.",
        fixHint: "Set a valid bot token for Telegram in your config or .env file.",
      });
    }
    if (typeof telegram.botToken === "string" && unresolvedEnvPattern.test(telegram.botToken)) {
      findings.push({
        id: "config:telegram-unresolved-env",
        level: "fail",
        summary: "Telegram botToken is unresolved env placeholder.",
        fixHint: "Ensure the environment variable referenced in telegram.botToken is set.",
      });
    }
  }

  const discord = config.channels?.discord;
  if (discord?.enabled) {
    if (discord.botToken === CONFIG_REDACTION_SENTINEL) {
      findings.push({
        id: "config:discord-redacted-token",
        level: "fail",
        summary: "Discord botToken is redacted sentinel and must be replaced.",
        fixHint: "Set a valid bot token for Discord in your config or .env file.",
      });
    }
    if (typeof discord.botToken === "string" && unresolvedEnvPattern.test(discord.botToken)) {
      findings.push({
        id: "config:discord-unresolved-env",
        level: "fail",
        summary: "Discord botToken is unresolved env placeholder.",
        fixHint: "Ensure the environment variable referenced in discord.botToken is set.",
      });
    }
  }

  const localDesktop = config.channels?.localDesktop;
  if (localDesktop?.enabled) {
    if (localDesktop.authToken === CONFIG_REDACTION_SENTINEL) {
      findings.push({
        id: "config:localDesktop-redacted-token",
        level: "fail",
        summary: "Local desktop authToken is redacted sentinel and must be replaced.",
        fixHint: "Set a valid auth token for local desktop in your config or .env file.",
      });
    }
    if (
      typeof localDesktop.authToken === "string" &&
      unresolvedEnvPattern.test(localDesktop.authToken)
    ) {
      findings.push({
        id: "config:localDesktop-unresolved-env",
        level: "fail",
        summary: "Local desktop authToken is unresolved env placeholder.",
        fixHint: "Ensure the environment variable referenced in localDesktop.authToken is set.",
      });
    }
  }

  return findings;
}

function hasRedactedValue(value: unknown): boolean {
  if (value === CONFIG_REDACTION_SENTINEL) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasRedactedValue(item));
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) => hasRedactedValue(item));
  }
  return false;
}
