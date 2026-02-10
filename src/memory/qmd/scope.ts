export type MemoryScopeRule = {
  action: "allow" | "deny";
  match?: {
    channel?: string;
    chatType?: "direct" | "group" | "channel";
    keyPrefix?: string;
  };
};

export type MemoryScopeConfig = {
  default?: "allow" | "deny";
  rules?: MemoryScopeRule[];
};

export function normalizeSessionKey(key: string): string | undefined {
  const trimmed = key.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.includes(":subagent:")) {
    return undefined;
  }
  return trimmed;
}

export function deriveChannelFromKey(key?: string): string | undefined {
  if (!key) {
    return undefined;
  }
  const normalized = normalizeSessionKey(key);
  if (!normalized) {
    return undefined;
  }
  const parts = normalized.split(":").filter(Boolean);
  if (parts[0] === "agent" && parts.length >= 3) {
    return parts[2];
  }
  if (parts.length >= 2) {
    return parts[1];
  }
  return undefined;
}

export function deriveChatTypeFromKey(key?: string): "direct" | "group" | "channel" | undefined {
  if (!key) {
    return undefined;
  }
  const normalized = normalizeSessionKey(key);
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes(":group:")) {
    return "group";
  }
  if (normalized.includes(":channel:")) {
    return "channel";
  }
  if (normalized.includes(":dm:")) {
    return "direct";
  }
  return "direct";
}

export function isScopeAllowed(scope: MemoryScopeConfig | undefined, sessionKey?: string): boolean {
  if (!scope) {
    return true;
  }
  const normalized = normalizeSessionKey(sessionKey ?? "");
  if (!normalized && sessionKey?.includes(":subagent:")) {
    return true;
  }
  const channel = deriveChannelFromKey(sessionKey);
  const chatType = deriveChatTypeFromKey(sessionKey);
  const normalizedKey = sessionKey ?? "";
  for (const rule of scope.rules ?? []) {
    if (!rule) {
      continue;
    }
    const match = rule.match ?? {};
    if (match.channel && match.channel !== channel) {
      continue;
    }
    if (match.chatType && match.chatType !== chatType) {
      continue;
    }
    if (match.keyPrefix && !normalizedKey.startsWith(match.keyPrefix)) {
      continue;
    }
    return rule.action === "allow";
  }
  const fallback = scope.default ?? "allow";
  return fallback === "allow";
}
