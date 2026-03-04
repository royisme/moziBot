import type { MoziConfig } from "../config/schema";
import { listAcpSessionEntries } from "./runtime/session-meta";

/**
 * Checks if a session key represents an ACP session.
 *
 * In moziBot, session keys look like:
 *   agent:{agentId}:{channel}:dm:{peerId}[:thread:{threadId}]
 *
 * An ACP session key would contain the `:acp:` segment.
 */
export function isAcpSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return false;
  }
  const normalized = raw.toLowerCase();
  const segments = normalized.split(":").filter(Boolean);
  if (segments.length < 3) {
    return false;
  }
  // Canonical ACP session shape starts with agent:<id>:acp:...
  return segments[0] === "agent" && segments[2] === "acp";
}

/**
 * Resolves a session key from a key or label.
 */
export async function resolveSessionKey(params: {
  keyOrLabel: string;
  config?: MoziConfig;
}): Promise<string | null> {
  const normalized = params.keyOrLabel.trim();
  if (!normalized) {
    return null;
  }

  // If it looks like a full session key, use it directly.
  if (normalized.includes(":")) {
    return normalized;
  }

  const allowedAgents = new Set(
    (params.config?.acp?.allowedAgents ?? [])
      .map((agent) => agent.trim().toLowerCase())
      .filter(Boolean),
  );

  const sessions = listAcpSessionEntries()
    .filter((session) => isAcpSessionKey(session.sessionKey))
    .filter((session) => {
      const [, agentId] = session.sessionKey.split(":");
      const agent = (agentId ?? "").trim().toLowerCase();
      if (allowedAgents.size > 0 && !allowedAgents.has(agent)) {
        return false;
      }
      return true;
    })
    .toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey));

  const query = normalized.toLowerCase();
  const exact = sessions.find((session) => {
    const label = session.acp?.runtimeSessionName?.trim().toLowerCase();
    return Boolean(label) && label === query;
  });
  if (exact) {
    return exact.sessionKey;
  }

  const partial = sessions.find((session) => {
    const rawLabel = session.acp?.runtimeSessionName;
    if (typeof rawLabel !== "string") {
      return false;
    }
    const label = rawLabel.trim().toLowerCase();
    return label.length > 0 && label.includes(query);
  });
  return partial?.sessionKey ?? null;
}
