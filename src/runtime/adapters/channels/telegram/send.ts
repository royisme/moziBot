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

  try {
    let sentMessage: { message_id: number };

    if (message.media?.length) {
      const media = message.media[0];
      if (media.type === "photo" && media.buffer) {
        sentMessage = await bot.api.sendPhoto(chatId, new InputFile(media.buffer), {
          caption: htmlText || undefined,
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        });
      } else if (media.buffer) {
        sentMessage = await bot.api.sendDocument(chatId, new InputFile(media.buffer), {
          caption: htmlText || undefined,
          parse_mode: "HTML",
        });
      } else {
        sentMessage = await sendTextWithChunking(bot, chatId, rawText, htmlText, replyMarkup);
      }
    } else {
      sentMessage = await sendTextWithChunking(bot, chatId, rawText, htmlText, replyMarkup);
    }

    return sentMessage.message_id.toString();
  } catch (error) {
    if (isTelegramParseError(error) && rawText) {
      logger.warn({ error, chatId }, "Telegram HTML parse failed, retrying with plain text");
      const fallback = await sendTextWithChunking(bot, chatId, rawText, rawText, replyMarkup);
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
): Promise<{ message_id: number }> {
  const textToSend = htmlText || rawText;

  if (textToSend.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
    return await bot.api.sendMessage(chatId, textToSend, {
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    });
  }

  const chunks = chunkMessage(rawText);
  let lastSentMessage: { message_id: number } | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const isLastChunk = i === chunks.length - 1;
    const chunkHtml = markdownToTelegramHtml(chunk);

    try {
      lastSentMessage = await bot.api.sendMessage(chatId, chunkHtml || chunk, {
        parse_mode: "HTML",
        reply_markup: isLastChunk ? replyMarkup : undefined,
      });
    } catch (error) {
      if (isTelegramParseError(error)) {
        lastSentMessage = await bot.api.sendMessage(chatId, chunk, {
          reply_markup: isLastChunk ? replyMarkup : undefined,
        });
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
    await bot.api.editMessageText(peerId, parseInt(messageId), htmlText, {
      parse_mode: "HTML",
    });
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
        await bot.api.editMessageText(peerId, parseInt(messageId), newText);
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
