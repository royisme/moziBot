import { isSilentReplyText } from "../../reply-utils";

/**
 * Reply suppression policy service.
 *
 * Delivery text ownership is handled in execution-flow (in-turn stream/final events).
 * This service only decides whether an already-resolved reply should be suppressed.
 */

export interface MessageRawShape {
  readonly source?: string;
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
