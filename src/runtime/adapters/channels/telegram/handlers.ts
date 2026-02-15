import type { Context } from "grammy";
import type { InboundMessage } from "../types";
import type { TelegramPluginConfig } from "./plugin";
import { logger } from "../../../../logger";
import { isSenderAllowed, isCommandText, isBotMentioned } from "./access";

export async function handleMessage(
  ctx: Context,
  config: TelegramPluginConfig,
  channelId: string,
  botUsername: string | null,
  botId: string | null,
  getDownloadUrl: (fileId: string) => Promise<string | undefined>,
  emitMessage: (msg: InboundMessage) => void,
): Promise<void> {
  const msg = ctx.message;
  if (!msg) {
    return;
  }

  const chatId = msg.chat.id.toString();
  const senderId = msg.from?.id.toString() || "unknown";
  const senderUsername = msg.from?.username || undefined;
  const text = msg.text || msg.caption || "";
  const peerType = msg.chat.type === "private" ? "dm" : "group";

  // Check whitelist if configured
  if (config.allowedChats?.length) {
    if (!config.allowedChats.includes(chatId)) {
      logger.info({ chatId, senderId }, "Telegram message dropped by allowedChats");
      return;
    }
  }

  if (peerType === "dm" && config.dmPolicy === "allowlist") {
    if (!isSenderAllowed(config.allowFrom, senderId, senderUsername)) {
      logger.info(
        { chatId, senderId, senderUsername },
        "Telegram DM dropped by dmPolicy=allowlist",
      );
      return;
    }
  }

  if (peerType === "group") {
    const groupCfg = config.groups?.[chatId];
    const effectiveAllowFrom = groupCfg?.allowFrom || config.allowFrom;
    const groupPolicy = config.groupPolicy ?? "open";

    if (
      groupPolicy === "allowlist" &&
      !isSenderAllowed(effectiveAllowFrom, senderId, senderUsername)
    ) {
      logger.info(
        { chatId, senderId, senderUsername },
        "Telegram group message dropped by groupPolicy=allowlist",
      );
      return;
    }

    if (groupCfg?.requireMention === true && !isCommandText(text)) {
      const mentioned = isBotMentioned({
        text,
        msg,
        botUsername,
        botId,
      });
      if (!mentioned) {
        logger.info({ chatId, senderId }, "Telegram group message dropped by requireMention=true");
        return;
      }
    }
  }

  if (!text && !msg.photo && !msg.document && !msg.voice && !msg.audio && !msg.video) {
    logger.debug({ chatId, senderId }, "Telegram message dropped: empty text and no media");
    return;
  }

  // Build inbound message
  const inbound: InboundMessage = {
    id: msg.message_id.toString(),
    channel: channelId,
    peerId: chatId,
    peerType,
    senderId,
    senderName: msg.from?.first_name || "Unknown",
    text,
    timestamp: new Date(msg.date * 1000),
    raw: msg,
  };

  // Handle attachments
  const media: NonNullable<InboundMessage["media"]> = [];
  if (msg.photo) {
    const photo = msg.photo[msg.photo.length - 1]; // Largest size
    media.push({
      type: "photo",
      url: photo.file_id,
      mimeType: "image/jpeg",
      caption: msg.caption,
      byteSize: photo.file_size,
      width: photo.width,
      height: photo.height,
    });
  }

  if (msg.document) {
    media.push({
      type: "document",
      url: msg.document.file_id,
      filename: msg.document.file_name,
      mimeType: msg.document.mime_type,
      caption: msg.caption,
      byteSize: msg.document.file_size,
    });
  }

  if (msg.voice) {
    const downloadUrl = await getDownloadUrl(msg.voice.file_id);
    media.push({
      type: "voice",
      url: downloadUrl || msg.voice.file_id,
      mimeType: msg.voice.mime_type,
      caption: msg.caption,
      byteSize: msg.voice.file_size,
      durationMs: typeof msg.voice.duration === "number" ? msg.voice.duration * 1000 : undefined,
    });
  }

  if (msg.audio) {
    const downloadUrl = await getDownloadUrl(msg.audio.file_id);
    media.push({
      type: "audio",
      url: downloadUrl || msg.audio.file_id,
      filename: msg.audio.file_name,
      mimeType: msg.audio.mime_type,
      caption: msg.caption,
      byteSize: msg.audio.file_size,
      durationMs: typeof msg.audio.duration === "number" ? msg.audio.duration * 1000 : undefined,
    });
  }

  if (msg.video) {
    media.push({
      type: "video",
      url: msg.video.file_id,
      mimeType: msg.video.mime_type,
      caption: msg.caption,
      byteSize: msg.video.file_size,
      width: msg.video.width,
      height: msg.video.height,
      durationMs: typeof msg.video.duration === "number" ? msg.video.duration * 1000 : undefined,
    });
  }

  if (media.length > 0) {
    inbound.media = media;
  }

  emitMessage(inbound);
}

export async function handleCallback(
  ctx: Context,
  config: TelegramPluginConfig,
  channelId: string,
  emitMessage: (msg: InboundMessage) => void,
): Promise<void> {
  const callback = ctx.callbackQuery;
  if (!callback || !("data" in callback)) {
    return;
  }

  const chatId = callback.message?.chat.id.toString() || "unknown";
  const senderId = callback.from.id.toString();
  const senderUsername = callback.from.username || undefined;
  const peerType = callback.message?.chat.type === "private" ? "dm" : "group";

  if (peerType === "dm" && config.dmPolicy === "allowlist") {
    if (!isSenderAllowed(config.allowFrom, senderId, senderUsername)) {
      logger.info(
        { chatId, senderId, senderUsername },
        "Telegram callback dropped by dmPolicy=allowlist",
      );
      return;
    }
  }

  if (peerType === "group") {
    const groupCfg = config.groups?.[chatId];
    const effectiveAllowFrom = groupCfg?.allowFrom || config.allowFrom;
    if ((config.groupPolicy ?? "open") === "allowlist") {
      if (!isSenderAllowed(effectiveAllowFrom, senderId, senderUsername)) {
        logger.info(
          { chatId, senderId, senderUsername },
          "Telegram callback dropped by groupPolicy=allowlist",
        );
        return;
      }
    }
  }

  const inbound: InboundMessage = {
    id: callback.id,
    channel: channelId,
    peerId: chatId,
    peerType,
    senderId,
    senderName: callback.from.first_name || "Unknown",
    text: callback.data ?? "",
    timestamp: new Date(),
    raw: callback,
  };

  // Answer the callback to remove loading state
  await ctx.answerCallbackQuery();

  emitMessage(inbound);
}
