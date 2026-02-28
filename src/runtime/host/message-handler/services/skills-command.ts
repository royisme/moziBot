interface SendChannel {
  send(peerId: string, payload: { text: string }): Promise<unknown>;
}

interface SkillSummary {
  name: string;
  description?: string;
}

interface SkillsInventory {
  enabled: SkillSummary[];
  loadedButDisabled: SkillSummary[];
  missingConfigured: string[];
  allowlistActive: boolean;
}

interface AgentManagerLike {
  listSkillsInventory?(agentId: string): Promise<SkillsInventory>;
  listAvailableSkills?(agentId: string): Promise<SkillSummary[]>;
}

const MAX_DISABLED_SKILLS = 8;
const MAX_CONFIGURED_MISSING = 6;
const MAX_DESC_CHARS = 96;

function summarizeDescription(description?: string): string | undefined {
  const raw = description?.trim();
  if (!raw) {
    return undefined;
  }
  const firstSentence = raw.split(/(?<=[.!?])\s+/)[0]?.trim() || raw;
  if (firstSentence.length <= MAX_DESC_CHARS) {
    return firstSentence;
  }
  return `${firstSentence.slice(0, MAX_DESC_CHARS - 3)}...`;
}

export async function handleSkillsCommand(params: {
  agentId: string;
  channel: SendChannel;
  peerId: string;
  agentManager: AgentManagerLike;
}): Promise<void> {
  const { agentId, channel, peerId, agentManager } = params;
  const inventory = agentManager.listSkillsInventory
    ? await agentManager.listSkillsInventory(agentId)
    : {
        enabled: (await agentManager.listAvailableSkills?.(agentId)) ?? [],
        loadedButDisabled: [],
        missingConfigured: [],
        allowlistActive: false,
      };
  if (inventory.enabled.length === 0 && inventory.loadedButDisabled.length === 0) {
    await channel.send(peerId, {
      text: "No skills available for the current agent.",
    });
    return;
  }

  const totalLoaded = inventory.enabled.length + inventory.loadedButDisabled.length;
  const lines = [`Skills: ${inventory.enabled.length} enabled / ${totalLoaded} loaded`, ""];

  lines.push("Enabled:");
  if (inventory.enabled.length === 0) {
    lines.push("• (none)");
  }
  for (const skill of inventory.enabled) {
    const summary = summarizeDescription(skill.description);
    lines.push(summary ? `• ${skill.name} - ${summary}` : `• ${skill.name}`);
  }

  if (inventory.loadedButDisabled.length > 0) {
    lines.push("");
    lines.push(`Loaded but not enabled (${inventory.loadedButDisabled.length}):`);
    const preview = inventory.loadedButDisabled.slice(0, MAX_DISABLED_SKILLS);
    for (const skill of preview) {
      lines.push(`• ${skill.name}`);
    }
    const hidden = inventory.loadedButDisabled.length - preview.length;
    if (hidden > 0) {
      lines.push(`• ...and ${hidden} more`);
    }
  }

  if (inventory.allowlistActive) {
    lines.push("");
    lines.push("Allowlist active: only agent-configured skills are enabled.");
    if (inventory.missingConfigured.length > 0) {
      const preview = inventory.missingConfigured.slice(0, MAX_CONFIGURED_MISSING);
      const hidden = inventory.missingConfigured.length - preview.length;
      const suffix = hidden > 0 ? ` (+${hidden} more)` : "";
      lines.push(`Configured but not loaded: ${preview.join(", ")}${suffix}`);
    }
  }
  await channel.send(peerId, { text: lines.join("\n") });
}
