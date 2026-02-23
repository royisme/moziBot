export type AccessPolicy = "open" | "allowlist";

export type DiscordGuildPolicyConfig = {
  requireMention?: boolean;
  allowFrom?: string[];
  agentId?: string;
  agent?: string;
};

export function normalizeGuildPolicies(
  guilds: Record<string, DiscordGuildPolicyConfig> | undefined,
): Record<string, DiscordGuildPolicyConfig> | undefined {
  if (!guilds) {
    return undefined;
  }
  const normalized: Record<string, DiscordGuildPolicyConfig> = {};
  for (const [guildId, config] of Object.entries(guilds)) {
    normalized[guildId] = {
      ...config,
      allowFrom: (config.allowFrom ?? []).map((item) => item.toString()),
    };
  }
  return normalized;
}

export function normalizeAllowList(allowFrom?: string[]): string[] | undefined {
  if (!allowFrom) {
    return undefined;
  }
  return allowFrom.map((item) => item.toString());
}

export function isSenderAllowed(
  allowFrom: string[] | undefined,
  senderId: string,
  senderUsername?: string,
): boolean {
  if (!allowFrom || allowFrom.length === 0) {
    return false;
  }
  const normalizedId = senderId.trim();
  const normalizedUsername = senderUsername?.trim().toLowerCase();
  return allowFrom.some((entryRaw) => {
    const entry = entryRaw.trim();
    if (!entry) {
      return false;
    }
    if (entry === normalizedId) {
      return true;
    }
    if (!normalizedUsername) {
      return false;
    }
    const value = entry.startsWith("@") ? entry.slice(1) : entry;
    return value.toLowerCase() === normalizedUsername;
  });
}

export function isCommandText(text: string): boolean {
  return text.trim().startsWith("/");
}

export function isBotMentioned(params: {
  text: string;
  mentions?: Array<{ id?: string }>;
  botId: string | null;
  botUsername: string | null;
}): boolean {
  if (params.botId) {
    const mentionMatch = (params.mentions ?? []).some((mention) => mention.id === params.botId);
    if (mentionMatch) {
      return true;
    }
    if (params.text.includes(`<@${params.botId}>`) || params.text.includes(`<@!${params.botId}>`)) {
      return true;
    }
  }
  if (params.botUsername && params.text.toLowerCase().includes(`@${params.botUsername}`)) {
    return true;
  }
  return false;
}
