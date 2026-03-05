import type { Context } from "grammy";
import { logger } from "../../../../logger";
import type { InboundMessage } from "../types";
import { isSenderAllowed, isCommandText, isBotMentioned } from "./access";
import { MediaGroupDebouncer } from "./debouncer";
import type { TelegramPluginConfig } from "./plugin";

const debouncerMap = new Map<string, MediaGroupDebouncer>();

function getDebouncer(channelId: string): MediaGroupDebouncer {
  if (!debouncerMap.has(channelId)) {
    debouncerMap.set(channelId, new MediaGroupDebouncer());
  }
  return debouncerMap.get(channelId)!;
}

function getReplyPreview(msg: Context["message"]): string | undefined {
  if (!msg?.reply_to_message) {
    return undefined;
  }
  const repliedText = msg.reply_to_message.text || msg.reply_to_message.caption || "";
  const normalized = repliedText.trim();
  return normalized ? normalized : undefined;
}

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
  const replyPreview = getReplyPreview(msg);
  const textWithReply = replyPreview
    ? `Replying to: ${replyPreview}${text ? `\n\n${text}` : ""}`
    : text;
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
    text: textWithReply,
    timestamp: new Date(msg.date * 1000),
    raw: msg,
    replyToId: msg.reply_to_message?.message_id?.toString(),
    threadId: msg.message_thread_id?.toString(),
  };

  // Handle attachments
  const media: NonNullable<InboundMessage["media"]> = [];
  if (msg.photo) {
    const photo = msg.photo[msg.photo.length - 1]; // Largest size
    const downloadUrl = await getDownloadUrl(photo.file_id);

    // Prefer downloading to a local temp path so the multimodal pipeline does not rely on a URL fetch.
    // Telegram file URLs require the bot token; some provider fetchers won't have access.
    let localPath: string | undefined;
    if (downloadUrl) {
      try {
        const res = await fetch(downloadUrl);
        if (res.ok) {
          const arrayBuffer = await res.arrayBuffer();
          const buf = Buffer.from(arrayBuffer);
          const os = await import("node:os");
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          const dir = path.join(os.tmpdir(), "mozi-telegram");
          await fs.mkdir(dir, { recursive: true });
          localPath = path.join(dir, `${channelId}-${msg.message_id}-${photo.file_id}.jpg`);
          await fs.writeFile(localPath, buf);
        }
      } catch {
        // best-effort; fallback to URL
      }
    }

    media.push({
      type: "photo",
      url: downloadUrl || photo.file_id,
      path: localPath,
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

  const mediaGroupId = (msg as unknown as { media_group_id?: string }).media_group_id;
  if (mediaGroupId) {
    getDebouncer(channelId).add(mediaGroupId, inbound, emitMessage);
  } else {
    emitMessage(inbound);
  }
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
