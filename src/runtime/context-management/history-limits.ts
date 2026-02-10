/**
 * History turn limits for DM sessions.
 *
 * Provides a simple mechanism to cap conversation history to the last N user turns.
 * Independent of pruning (which operates on tool results) and compaction (which
 * summarizes on overflow).
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * Limits conversation history to the last N user turns.
 * A "turn" starts at a user message and includes all subsequent
 * assistant/tool messages until the next user message.
 *
 * @param messages - Full message history
 * @param limit - Max user turns to keep. 0/undefined/negative = unlimited
 * @returns Trimmed message array
 */
export function limitHistoryTurns(
  messages: AgentMessage[],
  limit: number | undefined,
): AgentMessage[] {
  if (!limit || limit <= 0 || messages.length === 0) {
    return messages;
  }

  let userCount = 0;
  let lastUserIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount > limit) {
        return messages.slice(lastUserIndex);
      }
      lastUserIndex = i;
    }
  }

  return messages;
}

/**
 * Check if a session key represents a DM session.
 * Session keys with `:dm:` segment are DM sessions.
 *
 * @param sessionKey - The session key
 * @returns true if DM session
 */
export function isDmSessionKey(sessionKey: string): boolean {
  return sessionKey.includes(":dm:");
}

/**
 * Extract peer ID from a DM session key.
 * Returns the segment after `:dm:`.
 *
 * @param sessionKey - The session key
 * @returns Peer ID or undefined if not a DM session
 */
export function extractDmPeerId(sessionKey: string): string | undefined {
  const dmIndex = sessionKey.indexOf(":dm:");
  if (dmIndex < 0) {
    return undefined;
  }
  const afterDm = sessionKey.slice(dmIndex + 4); // Length of ":dm:"
  // Handle thread suffix: "peerId:thread:threadId" -> "peerId"
  const threadIndex = afterDm.indexOf(":thread:");
  return threadIndex >= 0 ? afterDm.slice(0, threadIndex) : afterDm;
}

/**
 * Resolve history limit from session key and config.
 * Supports per-user overrides and channel-level defaults.
 *
 * Session key formats:
 * - `agent:{agentId}:{channel}:dm:{peerId}`
 * - `agent:{agentId}:dm:{peerId}`
 * - `agent:{agentId}:{channel}:{accountId}:dm:{peerId}`
 *
 * @param sessionKey - The session key
 * @param channelConfig - Channel configuration with dmHistoryLimit and dms
 * @returns The resolved limit or undefined if not configured
 */
export function resolveHistoryLimitFromSessionKey(
  sessionKey: string,
  channelConfig?: {
    dmHistoryLimit?: number;
    dms?: Record<string, { historyLimit?: number }>;
  },
): number | undefined {
  if (!channelConfig) {
    return undefined;
  }

  if (!isDmSessionKey(sessionKey)) {
    return undefined;
  }

  const peerId = extractDmPeerId(sessionKey);
  if (peerId && channelConfig.dms?.[peerId]?.historyLimit !== undefined) {
    return channelConfig.dms[peerId].historyLimit;
  }

  return channelConfig.dmHistoryLimit;
}
