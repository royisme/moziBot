/**
 * Outbound send logic for WeChat (ilink bot).
 */

import crypto from "node:crypto";
import { logger } from "../../../../logger";
import { sendMessage as sendMessageApi } from "./api";
import { MessageItemType, MessageState, MessageType } from "./types";
import type { SendMessageReq } from "./types";

// ---------------------------------------------------------------------------
// Markdown stripping
// ---------------------------------------------------------------------------

/**
 * Convert markdown-formatted text to plain text for WeChat delivery.
 * WeChat cannot render markdown.
 */
export function markdownToPlainText(text: string): string {
  let result = text;
  // Code blocks: strip fences, keep code content
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_match, code: string) => code.trim());
  // Images: remove entirely
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // Links: keep display text only
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Table separator rows: remove
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  // Table rows: strip surrounding pipes, join cells with spaces
  result = result.replace(/^\|(.+)\|$/gm, (_match, inner: string) =>
    inner
      .split("|")
      .map((cell) => cell.trim())
      .join("  "),
  );
  // Bold/italic: **text** -> text, *text* -> text, __text__ -> text, _text_ -> text
  result = result.replace(/\*\*([^*]+)\*\*/g, "$1");
  result = result.replace(/\*([^*]+)\*/g, "$1");
  result = result.replace(/__([^_]+)__/g, "$1");
  result = result.replace(/_([^_]+)_/g, "$1");
  // Headers: # text -> text
  result = result.replace(/^#{1,6}\s+/gm, "");
  // Inline code: `code` -> code
  result = result.replace(/`([^`]+)`/g, "$1");
  // Horizontal rules
  result = result.replace(/^[-*_]{3,}$/gm, "");
  // Collapse multiple blank lines into one
  result = result.replace(/\n{3,}/g, "\n\n").trim();
  return result;
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

function generateClientId(): string {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * Send plain text to a WeChat user.
 * Strips markdown before sending.
 * Retries once on failure after 2 s.
 * Returns the client_id (message ID).
 */
export async function sendText(params: {
  peerId: string;
  text: string;
  contextToken: string;
  baseUrl: string;
  token?: string;
}): Promise<string> {
  const { peerId, text, contextToken, baseUrl, token } = params;
  const plainText = markdownToPlainText(text);
  const clientId = generateClientId();

  const req: SendMessageReq = {
    msg: {
      from_user_id: "",
      to_user_id: peerId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: plainText } }],
    },
  };

  const doSend = async () =>
    sendMessageApi({
      baseUrl,
      token,
      body: req,
    });

  try {
    await doSend();
    return clientId;
  } catch (err) {
    logger.warn({ err, peerId, clientId }, "wechat sendText: first attempt failed, retrying in 2s");
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    try {
      await doSend();
      return clientId;
    } catch (err2) {
      logger.error({ err: err2, peerId, clientId }, "wechat sendText: retry failed, giving up");
      throw err2;
    }
  }
}
