import { run, sequentialize } from "@grammyjs/runner";
import { Bot, InputFile, type Context } from "grammy";
import type { InboundMessage, OutboundMessage } from "../types";
import { logger } from "../../../../logger";
import { BaseChannelPlugin } from "../plugin";
import {
  chunkMessage,
  isTelegramParseError,
  markdownToTelegramHtml,
  TELEGRAM_MAX_MESSAGE_LENGTH,
} from "./render";

type AccessPolicy = "open" | "allowlist";

type TelegramGroupPolicyConfig = {
  requireMention?: boolean;
  allowFrom?: string[];
  agentId?: string;
  agent?: string;
};

export interface TelegramPluginConfig {
  botToken: string;
  allowedChats?: string[]; // Optional whitelist
  dmPolicy?: AccessPolicy;
  groupPolicy?: AccessPolicy;
  allowFrom?: string[];
  groups?: Record<string, TelegramGroupPolicyConfig>;
  streamMode?: "off" | "partial" | "full";
  polling?: {
    timeoutSeconds?: number;
    maxRetryTimeMs?: number;
    retryInterval?: "exponential" | "quadratic" | number;
    silentRunnerErrors?: boolean;
  };
}

const TYPING_INTERVAL_MS = 6_000;
const TYPING_TTL_MS = 2 * 60_000;

type TypingLoopState = {
  refs: number;
  interval: ReturnType<typeof setInterval>;
  ttl: ReturnType<typeof setTimeout>;
};

export class TelegramPlugin extends BaseChannelPlugin {
  readonly id = "telegram";
  readonly name = "Telegram";

  private bot: Bot;
  private config: TelegramPluginConfig;
  private runner: ReturnType<typeof run> | null = null;
  private botUsername: string | null = null;
  private botId: string | null = null;
  private typingLoops = new Map<string, TypingLoopState>();

  constructor(config: TelegramPluginConfig) {
    super();
    this.config = {
      ...config,
      allowedChats: (config.allowedChats ?? []).map((item) => item.toString()),
      allowFrom: (config.allowFrom ?? []).map((item) => item.toString()),
      groups: normalizeGroupPolicies(config.groups),
      polling: {
        timeoutSeconds: config.polling?.timeoutSeconds ?? 30,
        maxRetryTimeMs: config.polling?.maxRetryTimeMs ?? 60_000,
        retryInterval: config.polling?.retryInterval ?? "exponential",
        silentRunnerErrors: config.polling?.silentRunnerErrors ?? true,
      },
    };
    this.bot = new Bot(config.botToken);
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Sequentialize updates per chat to avoid race conditions
    this.bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));

    // Handle text messages
    this.bot.on("message:text", (ctx) => this.handleMessage(ctx));

    // Handle photos
    this.bot.on("message:photo", (ctx) => this.handleMessage(ctx));

    // Handle documents
    this.bot.on("message:document", (ctx) => this.handleMessage(ctx));

    // Handle voice/audio/video
    this.bot.on("message:voice", (ctx) => this.handleMessage(ctx));
    this.bot.on("message:audio", (ctx) => this.handleMessage(ctx));
    this.bot.on("message:video", (ctx) => this.handleMessage(ctx));

    // Handle callback queries (button clicks)
    this.bot.on("callback_query:data", (ctx) => this.handleCallback(ctx));

    // Error handling
    this.bot.catch((err) => {
      logger.error({ err: err.error }, "Telegram bot error");
      this.emitError(err.error as Error);
    });
  }

  private async handleMessage(ctx: Context): Promise<void> {
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
    if (this.config.allowedChats?.length) {
      if (!this.config.allowedChats.includes(chatId)) {
        logger.info({ chatId, senderId }, "Telegram message dropped by allowedChats");
        return;
      }
    }

    if (peerType === "dm" && this.config.dmPolicy === "allowlist") {
      if (!isSenderAllowed(this.config.allowFrom, senderId, senderUsername)) {
        logger.info(
          { chatId, senderId, senderUsername },
          "Telegram DM dropped by dmPolicy=allowlist",
        );
        return;
      }
    }

    if (peerType === "group") {
      const groupCfg = this.config.groups?.[chatId];
      const effectiveAllowFrom = groupCfg?.allowFrom || this.config.allowFrom;
      const groupPolicy = this.config.groupPolicy ?? "open";

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
          botUsername: this.botUsername,
          botId: this.botId,
        });
        if (!mentioned) {
          logger.info(
            { chatId, senderId },
            "Telegram group message dropped by requireMention=true",
          );
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
      channel: this.id,
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
      media.push({
        type: "voice",
        url: msg.voice.file_id,
        mimeType: msg.voice.mime_type,
        caption: msg.caption,
        byteSize: msg.voice.file_size,
        durationMs: typeof msg.voice.duration === "number" ? msg.voice.duration * 1000 : undefined,
      });
    }

    if (msg.audio) {
      media.push({
        type: "audio",
        url: msg.audio.file_id,
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

    this.emitMessage(inbound);
  }

  private async handleCallback(ctx: Context): Promise<void> {
    const callback = ctx.callbackQuery;
    if (!callback || !("data" in callback)) {
      return;
    }

    const chatId = callback.message?.chat.id.toString() || "unknown";
    const senderId = callback.from.id.toString();
    const senderUsername = callback.from.username || undefined;
    const peerType = callback.message?.chat.type === "private" ? "dm" : "group";

    if (peerType === "dm" && this.config.dmPolicy === "allowlist") {
      if (!isSenderAllowed(this.config.allowFrom, senderId, senderUsername)) {
        logger.info(
          { chatId, senderId, senderUsername },
          "Telegram callback dropped by dmPolicy=allowlist",
        );
        return;
      }
    }

    if (peerType === "group") {
      const groupCfg = this.config.groups?.[chatId];
      const effectiveAllowFrom = groupCfg?.allowFrom || this.config.allowFrom;
      if ((this.config.groupPolicy ?? "open") === "allowlist") {
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
      channel: this.id,
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

    this.emitMessage(inbound);
  }

  async connect(): Promise<void> {
    try {
      const me = await this.bot.api.getMe();
      this.botUsername = me.username?.trim().toLowerCase() || null;
      this.botId = me.id?.toString() || null;

      await this.registerCommands();

      this.runner = run(this.bot, {
        runner: {
          fetch: {
            timeout: this.config.polling?.timeoutSeconds,
          },
          maxRetryTime: this.config.polling?.maxRetryTimeMs,
          retryInterval: this.config.polling?.retryInterval,
          silent: this.config.polling?.silentRunnerErrors,
        },
      });
      logger.info({ botUsername: this.botUsername }, "Telegram bot connected");
      this.setStatus("connected");
    } catch (error) {
      logger.error({ error }, "Failed to connect Telegram bot");
      this.setStatus("error");
      throw error;
    }
  }

  private async registerCommands(): Promise<void> {
    const commands = [
      { command: "help", description: "Show help information" },
      { command: "status", description: "View current status" },
      { command: "whoami", description: "View my identity information" },
      { command: "context", description: "View context details" },
      { command: "models", description: "List available models" },
      { command: "switch", description: "Switch model (usage: /switch provider/model)" },
      { command: "new", description: "Start a new session" },
      { command: "compact", description: "Compact session context" },
      { command: "restart", description: "Restart runtime" },
    ];

    try {
      await this.bot.api.deleteMyCommands();
      await this.bot.api.setMyCommands(commands);
      logger.info({ commandCount: commands.length }, "Telegram bot commands registered");
    } catch (error) {
      logger.warn({ error }, "Failed to register Telegram bot commands");
    }
  }

  async disconnect(): Promise<void> {
    this.stopAllTypingLoops();
    if (this.runner) {
      await this.runner.stop();
      this.runner = null;
    }
    logger.info("Telegram bot disconnected");
    this.setStatus("disconnected");
  }

  async send(peerId: string, message: OutboundMessage): Promise<string> {
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
          sentMessage = await this.bot.api.sendPhoto(chatId, new InputFile(media.buffer), {
            caption: htmlText || undefined,
            parse_mode: "HTML",
            reply_markup: replyMarkup,
          });
        } else if (media.buffer) {
          sentMessage = await this.bot.api.sendDocument(chatId, new InputFile(media.buffer), {
            caption: htmlText || undefined,
            parse_mode: "HTML",
          });
        } else {
          sentMessage = await this.sendTextWithChunking(chatId, rawText, htmlText, replyMarkup);
        }
      } else {
        sentMessage = await this.sendTextWithChunking(chatId, rawText, htmlText, replyMarkup);
      }

      return sentMessage.message_id.toString();
    } catch (error) {
      if (isTelegramParseError(error) && rawText) {
        logger.warn({ error, chatId }, "Telegram HTML parse failed, retrying with plain text");
        const fallback = await this.sendTextWithChunking(chatId, rawText, rawText, replyMarkup);
        return fallback.message_id.toString();
      }
      logger.error({ error, chatId }, "Failed to send Telegram message");
      throw error;
    }
  }

  private async sendTextWithChunking(
    chatId: string,
    rawText: string,
    htmlText: string,
    replyMarkup: { inline_keyboard: { text: string; callback_data: string }[][] } | undefined,
  ): Promise<{ message_id: number }> {
    const textToSend = htmlText || rawText;

    if (textToSend.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
      return await this.bot.api.sendMessage(chatId, textToSend, {
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
        lastSentMessage = await this.bot.api.sendMessage(chatId, chunkHtml || chunk, {
          parse_mode: "HTML",
          reply_markup: isLastChunk ? replyMarkup : undefined,
        });
      } catch (error) {
        if (isTelegramParseError(error)) {
          lastSentMessage = await this.bot.api.sendMessage(chatId, chunk, {
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

  async beginTyping(peerId: string): Promise<(() => Promise<void>) | void> {
    if (!this.runner) {
      return;
    }
    const existing = this.typingLoops.get(peerId);
    if (existing) {
      existing.refs += 1;
      return async () => {
        this.releaseTyping(peerId);
      };
    }

    await this.sendTypingAction(peerId);

    const interval = setInterval(() => {
      void this.sendTypingAction(peerId);
    }, TYPING_INTERVAL_MS);
    const ttl = setTimeout(() => {
      this.clearTypingLoop(peerId);
    }, TYPING_TTL_MS);
    this.typingLoops.set(peerId, {
      refs: 1,
      interval,
      ttl,
    });

    return async () => {
      this.releaseTyping(peerId);
    };
  }

  async react(messageId: string, peerId: string, emoji: string): Promise<void> {
    try {
      const api = this.bot.api as unknown as {
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

  async deleteMessage(messageId: string, peerId: string): Promise<void> {
    try {
      await this.bot.api.deleteMessage(peerId, parseInt(messageId));
    } catch (error) {
      logger.warn({ error, messageId }, "Failed to delete message");
    }
  }

  async editMessage(messageId: string, peerId: string, newText: string): Promise<void> {
    try {
      await this.bot.api.editMessageText(peerId, parseInt(messageId), newText, {
        parse_mode: "Markdown",
      });
    } catch (error) {
      logger.warn({ error, messageId }, "Failed to edit message");
    }
  }

  private async sendTypingAction(peerId: string): Promise<void> {
    try {
      await this.bot.api.sendChatAction(peerId, "typing");
    } catch (error) {
      logger.warn({ error, peerId }, "Failed to send Telegram typing indicator");
    }
  }

  private releaseTyping(peerId: string): void {
    const entry = this.typingLoops.get(peerId);
    if (!entry) {
      return;
    }
    entry.refs -= 1;
    if (entry.refs <= 0) {
      this.clearTypingLoop(peerId);
    }
  }

  private clearTypingLoop(peerId: string): void {
    const entry = this.typingLoops.get(peerId);
    if (!entry) {
      return;
    }
    clearInterval(entry.interval);
    clearTimeout(entry.ttl);
    this.typingLoops.delete(peerId);
  }

  private stopAllTypingLoops(): void {
    for (const peerId of this.typingLoops.keys()) {
      this.clearTypingLoop(peerId);
    }
  }
}

function normalizeGroupPolicies(
  groups: Record<string, TelegramGroupPolicyConfig> | undefined,
): Record<string, TelegramGroupPolicyConfig> | undefined {
  if (!groups) {
    return undefined;
  }
  const normalized: Record<string, TelegramGroupPolicyConfig> = {};
  for (const [chatId, group] of Object.entries(groups)) {
    normalized[chatId] = {
      ...group,
      allowFrom: (group.allowFrom ?? []).map((item) => item.toString()),
    };
  }
  return normalized;
}

function isSenderAllowed(
  allowFrom: string[] | undefined,
  senderId: string,
  senderUsername?: string,
): boolean {
  if (!allowFrom || allowFrom.length === 0) {
    return false;
  }
  const normalizedId = senderId.trim();
  const normalizedUsername = senderUsername?.trim().toLowerCase();
  return allowFrom.some((entryRaw) => {
    const entry = entryRaw.trim();
    if (!entry) {
      return false;
    }
    if (entry === normalizedId) {
      return true;
    }
    if (!normalizedUsername) {
      return false;
    }
    const value = entry.startsWith("@") ? entry.slice(1) : entry;
    return value.toLowerCase() === normalizedUsername;
  });
}

function isCommandText(text: string): boolean {
  return text.trim().startsWith("/");
}

function isBotMentioned(params: {
  text: string;
  msg: Context["message"];
  botUsername: string | null;
  botId: string | null;
}): boolean {
  const loweredText = params.text.toLowerCase();
  if (params.botUsername && loweredText.includes(`@${params.botUsername}`)) {
    return true;
  }

  const entities =
    (params.msg as { entities?: Array<Record<string, unknown>> }).entities ||
    (params.msg as { caption_entities?: Array<Record<string, unknown>> }).caption_entities ||
    [];

  for (const entity of entities) {
    const type = typeof entity.type === "string" ? entity.type : "";
    if (type === "mention") {
      const offset = typeof entity.offset === "number" ? entity.offset : -1;
      const length = typeof entity.length === "number" ? entity.length : 0;
      if (offset < 0 || length <= 0) {
        continue;
      }
      const mention = params.text
        .slice(offset, offset + length)
        .trim()
        .toLowerCase();
      if (params.botUsername && mention === `@${params.botUsername}`) {
        return true;
      }
      continue;
    }
    if (type === "text_mention") {
      const userId = (entity.user as { id?: number } | undefined)?.id?.toString();
      if (params.botId && userId === params.botId) {
        return true;
      }
    }
  }
  return false;
}
