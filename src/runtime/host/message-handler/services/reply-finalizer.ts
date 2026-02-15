import { renderAssistantReply, isSilentReplyText } from "../../reply-utils";
import type { ReplyRenderOptions } from "../render/reasoning";

/**
 * Reply Finalization Policy Service
 * 
 * Manages the transformation of agent messages into final reply text and 
 * implements suppression rules for silent/heartbeat responses.
 */

export interface AssistantMessageShape {
  readonly role: string;
  readonly content?: unknown;
}

export interface MessageRawShape {
  readonly source?: string;
}

/**
 * Resolves the final reply text from a list of session messages.
 * Preserves monolith logic for finding and rendering the last assistant turn.
 */
export function resolveLastAssistantReplyText(params: {
  messages: readonly AssistantMessageShape[];
  renderOptions: ReplyRenderOptions;
}): string | undefined {
  const { messages, renderOptions } = params;

  // Parity: locate last assistant message
  const lastAssistant = [...messages]
    .toReversed()
    .find((m) => m.role === "assistant");

  if (!lastAssistant) {
    return undefined;
  }

  // Parity: render using renderAssistantReply
  return renderAssistantReply(lastAssistant.content, renderOptions);
}

/**
 * Determines if a reply should be suppressed based on the silent reply token.
 */
export function shouldSuppressSilentReply(replyText: string | undefined): boolean {
  return isSilentReplyText(replyText);
}

/**
 * Determines if a reply should be suppressed because it is a redundant heartbeat OK.
 */
export function shouldSuppressHeartbeatReply(
  messageRaw: MessageRawShape | undefined,
  replyText: string
): boolean {
  if (!messageRaw) {
    return false;
  }

  // Parity: suppress only when source === 'heartbeat' and trimmed replyText === 'HEARTBEAT_OK'
  return messageRaw.source === "heartbeat" && replyText.trim() === "HEARTBEAT_OK";
}
