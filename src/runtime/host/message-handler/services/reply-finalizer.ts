import { isSilentReplyText } from "../../reply-utils";

/**
 * Reply suppression policy service.
 *
 * Delivery text ownership is handled in execution-flow (in-turn stream/final events).
 * This service only decides whether an already-resolved reply should be suppressed.
 */

// Keep this list aligned to real message-turn sources that reach runExecutionFlow.
// `subagent-announce` is the current detached-run/subagent inbound source in repo reality;
// stale `detached-run-announce` wording and queue-side `watchdog` events are excluded because
// they do not enter execution-flow as `payload.raw.source` message turns.
const SYSTEM_INTERNAL_TURN_SOURCES = new Set(["heartbeat", "heartbeat-wake", "subagent-announce"]);

export interface MessageRawShape {
  readonly source?: string;
}

export function isSystemInternalTurnSource(source?: string): boolean {
  return typeof source === "string" && SYSTEM_INTERNAL_TURN_SOURCES.has(source);
}

/**
 * Determines if a reply should be suppressed based on the silent reply token.
 */
export function shouldSuppressSilentReply(
  replyText: string | undefined,
  opts?: {
    /** If true, do NOT suppress NO_REPLY. Useful when media is present and we want an explicit reply. */
    forceReply?: boolean;
  },
): boolean {
  if (opts?.forceReply) {
    return false;
  }
  return isSilentReplyText(replyText);
}

/**
 * Determines if a reply should be suppressed because it is a redundant heartbeat OK.
 */
export function shouldSuppressHeartbeatReply(
  messageRaw: MessageRawShape | undefined,
  replyText: string,
): boolean {
  if (!messageRaw) {
    return false;
  }

  // Parity: suppress only when source === 'heartbeat' and trimmed replyText === 'HEARTBEAT_OK'
  return messageRaw.source === "heartbeat" && replyText.trim() === "HEARTBEAT_OK";
}
