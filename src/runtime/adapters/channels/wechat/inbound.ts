/**
 * Inbound message normalization for WeChat (ilink bot).
 * contextTokenStore: Map<peerId, contextToken>
 */

import { logger } from "../../../../logger";
import type { InboundMessage } from "../types";
import { MessageItemType } from "./types";
import type { WeixinMessage, MessageItem } from "./types";

// ---------------------------------------------------------------------------
// Context token store — keyed by peerId (from_user_id)
// ---------------------------------------------------------------------------

export const contextTokenStore = new Map<string, string>();

export function setContextToken(peerId: string, token: string): void {
  contextTokenStore.set(peerId, token);
}

export function getContextToken(peerId: string): string | undefined {
  return contextTokenStore.get(peerId);
}

// ---------------------------------------------------------------------------
// Text body extraction
// ---------------------------------------------------------------------------

function isMediaItem(item: MessageItem): boolean {
  return (
    item.type === MessageItemType.IMAGE ||
    item.type === MessageItemType.VIDEO ||
    item.type === MessageItemType.FILE ||
    item.type === MessageItemType.VOICE
  );
}

function bodyFromItemList(itemList?: MessageItem[]): string {
  if (!itemList?.length) {
    return "";
  }
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) {
        return text;
      }
      // Quoted media — only include current text as body
      if (ref.message_item && isMediaItem(ref.message_item)) {
        return text;
      }
      // Build quoted context from title and/or message_item content
      const parts: string[] = [];
      if (ref.title) {
        parts.push(ref.title);
      }
      if (ref.message_item) {
        const refBody = bodyFromItemList([ref.message_item]);
        if (refBody) {
          parts.push(refBody);
        }
      }
      if (!parts.length) {
        return text;
      }
      return `[引用: ${parts.join(" | ")}]\n${text}`;
    }
    // ASR voice — use transcription text if present
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Main normalizer
// ---------------------------------------------------------------------------

/**
 * Convert a WeixinMessage from getUpdates to a mozi InboundMessage.
 * Returns null if message body is empty (silently dropped — no emitMessage call).
 */
export function weixinMessageToInbound(
  msg: WeixinMessage,
  channelId: string,
): InboundMessage | null {
  const peerId = msg.from_user_id ?? "";
  const text = bodyFromItemList(msg.item_list);

  if (!text) {
    logger.debug(
      { peerId, messageId: msg.message_id, types: msg.item_list?.map((i) => i.type) },
      "wechat: message body empty, dropping silently",
    );
    return null;
  }

  // Store context token for outbound replies
  if (msg.context_token) {
    setContextToken(peerId, msg.context_token);
  }

  const inbound: InboundMessage = {
    id: String(msg.message_id ?? ""),
    channel: channelId,
    peerId,
    peerType: "dm",
    senderId: peerId,
    text,
    timestamp: msg.create_time_ms ? new Date(msg.create_time_ms) : new Date(),
    raw: msg,
  };

  return inbound;
}
