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
  return normalized.includes(":acp:");
}

/**
 * Resolves a session key from a key or label.
 */
export async function resolveSessionKey(params: { keyOrLabel: string }): Promise<string | null> {
  const { keyOrLabel } = params;
  const normalized = keyOrLabel.trim();

  // If it looks like a full session key, use it directly
  if (normalized.includes(":")) {
    return normalized;
  }

  // Otherwise, search for a matching session by label
  const sessions = listAcpSessionEntries();
  for (const session of sessions) {
    const label = session.acp?.runtimeSessionName;
    if (label && label.toLowerCase() === normalized.toLowerCase()) {
      return session.sessionKey;
    }
  }

  // If no exact match, try partial match
  for (const session of sessions) {
    const label = session.acp?.runtimeSessionName;
    if (label && label.toLowerCase().includes(normalized.toLowerCase())) {
      return session.sessionKey;
    }
  }

  return null;
}
