import type { Bot } from "grammy";
import { InputFile } from "grammy";
import type { OutboundMessage } from "../types";
import { logger } from "../../../../logger";
import {
  chunkMessage,
  isTelegramMessageNotModifiedError,
  isTelegramParseError,
  markdownToTelegramHtml,
  TELEGRAM_MAX_MESSAGE_LENGTH,
} from "./render";
import { withTelegramRetry } from "./retry";

const TELEGRAM_CAPTION_MAX_LENGTH = 1024;
const MEDIA_URL_MAX_BYTES = 52_428_800; // 50MB

function isThreadNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = (error as any).message ?? "";
  return msg.includes("message thread not found") || msg.includes("TOPIC_CLOSED");
}

export async function sendMessage(
  bot: Bot,
  peerId: string,
  message: OutboundMessage,
  _botToken: string,
): Promise<string> {
  const chatId = peerId;
  const rawText = message.text || "";
  const htmlText = markdownToTelegramHtml(rawText);
  const replyMarkup = message.buttons
    ? {
        inline_keyboard: message.buttons.map((row) =>
          row.map((btn) => ({
            text: btn.text,
            callback_data: btn.callbackData ?? btn.url ?? btn.text,
          })),
        ),
      }
    : undefined;

  const replyParameters = message.replyToId
    ? { message_id: Number(message.replyToId) }
    : undefined;
  const disableNotification = message.silent === true;
  const messageThreadId = message.threadId ? Number(message.threadId) : undefined;

  async function doSend(threadId: number | undefined): Promise<{ message_id: number }> {
    let sentMessage: { message_id: number };

    if (message.media?.length) {
      const media = message.media[0];

      // A4 — URL media download: fetch URL to buffer if no buffer provided
      if (!media.buffer && media.url && media.url.startsWith("http")) {
        try {
          const response = await fetch(media.url, {
            signal: AbortSignal.timeout(30_000),
          });
          const contentLength = response.headers.get("content-length");
          if (contentLength && parseInt(contentLength) > MEDIA_URL_MAX_BYTES) {
            logger.warn(
              { url: media.url, size: contentLength },
              "Media URL exceeds 50MB limit, falling back to text-only",
            );
          } else {
            media.buffer = Buffer.from(await response.arrayBuffer());
          }
        } catch (error) {
          logger.warn(
            { error, url: media.url },
            "Failed to download media from URL, falling back to text-only",
          );
        }
      }

      if (!media.buffer) {
        // No buffer, send text only
        sentMessage = await sendTextWithChunking(
          bot, chatId, rawText, htmlText, replyMarkup, replyParameters, disableNotification, threadId,
        );
      } else {
        const inputFile = new InputFile(media.buffer, media.filename);
        const caption = htmlText || undefined;
        const parseMode = "HTML" as const;

        // A3 — Caption chunking: Telegram caps captions at 1024 chars
        const needsCaptionSplit = !!caption && caption.length > TELEGRAM_CAPTION_MAX_LENGTH;
        const effectiveCaption = needsCaptionSplit ? undefined : caption;

        const baseOptions = {
          caption: effectiveCaption,
          parse_mode: parseMode,
          reply_markup: replyMarkup,
          reply_parameters: replyParameters,
          disable_notification: disableNotification,
          message_thread_id: threadId,
        };

        switch (media.type) {
          case "photo":
            sentMessage = await withTelegramRetry(
              () => bot.api.sendPhoto(chatId, inputFile, baseOptions),
              "sendPhoto",
            );
            break;

          case "video":
            if (media.asVideoNote) {
              sentMessage = await withTelegramRetry(
                () => bot.api.sendVideoNote(chatId, inputFile, {
                  reply_markup: replyMarkup,
                  reply_parameters: replyParameters,
                  disable_notification: disableNotification,
                  message_thread_id: threadId,
                }),
                "sendVideoNote",
              );
            } else {
              sentMessage = await withTelegramRetry(
                () => bot.api.sendVideo(chatId, inputFile, baseOptions),
                "sendVideo",
              );
            }
            break;

          case "video_note":
            sentMessage = await withTelegramRetry(
              () => bot.api.sendVideoNote(chatId, inputFile, {
                reply_markup: replyMarkup,
                reply_parameters: replyParameters,
                disable_notification: disableNotification,
                message_thread_id: threadId,
              }),
              "sendVideoNote",
            );
            break;

          case "audio":
            if (media.asVoice) {
              sentMessage = await withTelegramRetry(
                () => bot.api.sendVoice(chatId, inputFile, {
                  caption: effectiveCaption,
                  parse_mode: parseMode,
                  reply_markup: replyMarkup,
                  reply_parameters: replyParameters,
                  disable_notification: disableNotification,
                  message_thread_id: threadId,
                }),
                "sendVoice",
              );
            } else {
              sentMessage = await withTelegramRetry(
                () => bot.api.sendAudio(chatId, inputFile, baseOptions),
                "sendAudio",
              );
            }
            break;

          case "voice":
            sentMessage = await withTelegramRetry(
              () => bot.api.sendVoice(chatId, inputFile, {
                caption: effectiveCaption,
                parse_mode: parseMode,
                reply_markup: replyMarkup,
                reply_parameters: replyParameters,
                disable_notification: disableNotification,
                message_thread_id: threadId,
              }),
              "sendVoice",
            );
            break;

          case "animation":
          case "gif":
            sentMessage = await withTelegramRetry(
              () => bot.api.sendAnimation(chatId, inputFile, baseOptions),
              "sendAnimation",
            );
            break;

          case "document":
          default:
            sentMessage = await withTelegramRetry(
              () => bot.api.sendDocument(chatId, inputFile, baseOptions),
              "sendDocument",
            );
            break;
        }

        // A3 — If caption was split, send text as follow-up
        if (needsCaptionSplit && htmlText) {
          await sendTextWithChunking(bot, chatId, rawText, htmlText, undefined, undefined, undefined, threadId);
        }
      }
    } else {
      sentMessage = await sendTextWithChunking(
        bot, chatId, rawText, htmlText, replyMarkup, replyParameters, disableNotification, threadId,
      );
    }

    return sentMessage;
  }

  try {
    let sentMessage: { message_id: number };

    try {
      sentMessage = await doSend(messageThreadId);
    } catch (threadError) {
      if (isThreadNotFoundError(threadError) && messageThreadId !== undefined) {
        logger.warn({ chatId, messageThreadId }, "Thread not found, retrying without message_thread_id");
        sentMessage = await doSend(undefined);
      } else {
        throw threadError;
      }
    }

    return sentMessage.message_id.toString();
  } catch (error) {
    if (isTelegramParseError(error) && rawText) {
      logger.warn({ error, chatId }, "Telegram HTML parse failed, retrying with plain text");
      const fallback = await sendTextWithChunking(
        bot, chatId, rawText, rawText, replyMarkup, replyParameters, disableNotification, messageThreadId,
      );
      return fallback.message_id.toString();
    }
    logger.error({ error, chatId }, "Failed to send Telegram message");
    throw error;
  }
}

async function sendTextWithChunking(
  bot: Bot,
  chatId: string,
  rawText: string,
  htmlText: string,
  replyMarkup: { inline_keyboard: { text: string; callback_data: string }[][] } | undefined,
  replyParameters?: { message_id: number },
  disableNotification?: boolean,
  messageThreadId?: number,
): Promise<{ message_id: number }> {
  const textToSend = htmlText || rawText;

  if (textToSend.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
    return await withTelegramRetry(
      () => bot.api.sendMessage(chatId, textToSend, {
        parse_mode: "HTML",
        reply_markup: replyMarkup,
        reply_parameters: replyParameters,
        disable_notification: disableNotification,
        message_thread_id: messageThreadId,
      }),
      "sendMessage",
    );
  }

  const chunks = chunkMessage(rawText);
  let lastSentMessage: { message_id: number } | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const isLastChunk = i === chunks.length - 1;
    const chunkHtml = markdownToTelegramHtml(chunk);

    try {
      lastSentMessage = await withTelegramRetry(
        () => bot.api.sendMessage(chatId, chunkHtml || chunk, {
          parse_mode: "HTML",
          reply_markup: isLastChunk ? replyMarkup : undefined,
          reply_parameters: isLastChunk ? replyParameters : undefined,
          disable_notification: disableNotification,
          message_thread_id: messageThreadId,
        }),
        "sendMessage",
      );
    } catch (error) {
      if (isTelegramParseError(error)) {
        lastSentMessage = await withTelegramRetry(
          () => bot.api.sendMessage(chatId, chunk, {
            reply_markup: isLastChunk ? replyMarkup : undefined,
            reply_parameters: isLastChunk ? replyParameters : undefined,
            disable_notification: disableNotification,
            message_thread_id: messageThreadId,
          }),
          "sendMessage",
        );
      } else {
        throw error;
      }
    }
  }

  if (!lastSentMessage) {
    throw new Error("No message was sent");
  }

  return lastSentMessage;
}

export async function reactToMessage(
  bot: Bot,
  messageId: string,
  peerId: string,
  emoji: string,
): Promise<void> {
  try {
    const api = bot.api as unknown as {
      setMessageReaction: (
        chatId: string,
        messageId: number,
        reactions: Array<{ type: "emoji"; emoji: string }>,
      ) => Promise<unknown>;
    };
    await api.setMessageReaction(peerId, parseInt(messageId), [
      {
        type: "emoji",
        emoji,
      },
    ]);
  } catch (error) {
    logger.warn({ error, messageId }, "Failed to set reaction");
  }
}

export async function deleteMsg(bot: Bot, messageId: string, peerId: string): Promise<void> {
  try {
    await bot.api.deleteMessage(peerId, parseInt(messageId));
  } catch (error) {
    logger.warn({ error, messageId }, "Failed to delete message");
  }
}

export async function editMsg(
  bot: Bot,
  messageId: string,
  peerId: string,
  newText: string,
): Promise<void> {
  const htmlText = markdownToTelegramHtml(newText);
  try {
    await withTelegramRetry(
      () => bot.api.editMessageText(peerId, parseInt(messageId), htmlText, {
        parse_mode: "HTML",
      }),
      "editMessageText",
    );
  } catch (error) {
    if (isTelegramMessageNotModifiedError(error)) {
      return;
    }

    if (isTelegramParseError(error)) {
      logger.warn(
        { error, messageId },
        "Telegram HTML parse failed on edit, retrying with plain text",
      );
      try {
        await withTelegramRetry(
          () => bot.api.editMessageText(peerId, parseInt(messageId), newText),
          "editMessageText",
        );
      } catch (fallbackError) {
        if (isTelegramMessageNotModifiedError(fallbackError)) {
          return;
        }
        logger.warn(
          { error: fallbackError, messageId },
          "Failed to edit message (plain text fallback)",
        );
        throw fallbackError;
      }
    } else {
      logger.warn({ error, messageId }, "Failed to edit message");
      throw error;
    }
  }
}

