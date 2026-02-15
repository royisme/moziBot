import type { Context } from "grammy";

export type AccessPolicy = "open" | "allowlist";

export type TelegramGroupPolicyConfig = {
  requireMention?: boolean;
  allowFrom?: string[];
  agentId?: string;
  agent?: string;
};

export function normalizeGroupPolicies(
  groups: Record<string, TelegramGroupPolicyConfig> | undefined,
): Record<string, TelegramGroupPolicyConfig> | undefined {
  if (!groups) {
    return undefined;
  }
  const normalized: Record<string, TelegramGroupPolicyConfig> = {};
  for (const [chatId, group] of Object.entries(groups)) {
    normalized[chatId] = {
      ...group,
      allowFrom: (group.allowFrom ?? []).map((item) => item.toString()),
    };
  }
  return normalized;
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
  msg: Context["message"];
  botUsername: string | null;
  botId: string | null;
}): boolean {
  const loweredText = params.text.toLowerCase();
  if (params.botUsername && loweredText.includes(`@${params.botUsername}`)) {
    return true;
  }

  const entities =
    (params.msg as { entities?: Array<Record<string, unknown>> }).entities ||
    (params.msg as { caption_entities?: Array<Record<string, unknown>> }).caption_entities ||
    [];

  for (const entity of entities) {
    const type = typeof entity.type === "string" ? entity.type : "";
    if (type === "mention") {
      const offset = typeof entity.offset === "number" ? entity.offset : -1;
      const length = typeof entity.length === "number" ? entity.length : 0;
      if (offset < 0 || length <= 0) {
        continue;
      }
      const mention = params.text
        .slice(offset, offset + length)
        .trim()
        .toLowerCase();
      if (params.botUsername && mention === `@${params.botUsername}`) {
        return true;
      }
      continue;
    }
    if (type === "text_mention") {
      const userId = (entity.user as { id?: number } | undefined)?.id?.toString();
      if (params.botId && userId === params.botId) {
        return true;
      }
    }
  }
  return false;
}
