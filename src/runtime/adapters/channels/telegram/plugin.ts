import { mkdir } from "node:fs/promises";
import { run, sequentialize } from "@grammyjs/runner";
import { Bot } from "grammy";
import { logger } from "../../../../logger";
import { BaseChannelPlugin } from "../plugin";
import { resolveStatusReactionEmojis, type StatusReactionEmojis } from "../status-reactions";
import type { OutboundMessage, StatusReaction, StatusReactionPayload } from "../types";
import { normalizeGroupPolicies, type TelegramGroupPolicyConfig } from "./access";
import { TelegramUpdateDedup } from "./dedup";
import { handleMessage, handleCallback } from "./handlers";
import {
  formatTelegramError,
  isGetUpdatesConflict,
  isRecoverableTelegramNetworkError,
} from "./network-errors";
import { sendMessage, reactToMessage, deleteMsg, editMsg } from "./send";
import { TypingManager } from "./typing";

interface StatusReactionsConfig {
  enabled?: boolean;
  emojis?: StatusReactionEmojis;
}

export interface TelegramPluginConfig {
  botToken: string;
  allowedChats?: string[]; // Optional whitelist
  dmPolicy?: "open" | "allowlist";
  groupPolicy?: "open" | "allowlist";
  allowFrom?: string[];
  groups?: Record<string, TelegramGroupPolicyConfig>;
  /** Stream mode: "off" = no streaming, "partial" = stream text only, "full" = stream + reasoning */
  streamMode?: "off" | "partial" | "full";
  polling?: {
    timeoutSeconds?: number;
    maxRetryTimeMs?: number;
    retryInterval?: "exponential" | "quadratic" | number;
    silentRunnerErrors?: boolean;
  };
  statusReactions?: StatusReactionsConfig;
}

export class TelegramPlugin extends BaseChannelPlugin {
  readonly id = "telegram";
  readonly name = "Telegram";

  private bot: Bot;
  private _config: TelegramPluginConfig;
  private dedup: TelegramUpdateDedup;
  private runner: ReturnType<typeof run> | null = null;
  private runnerTask: Promise<void> | null = null;
  private connectAbortController: AbortController | null = null;
  private stopRequested = false;
  private lastSupervisorError: Error | null = null;
  private botUsername: string | null = null;
  private botId: string | null = null;
  private typingManager: TypingManager;
  private statusReactionsEnabled: boolean;
  private statusReactionEmojis: Record<StatusReaction, string>;
  private statusReactionState = new Map<string, string>();

  /** Expose config for runtime to check streamMode */
  get config(): TelegramPluginConfig {
    return this._config;
  }

  constructor(config: TelegramPluginConfig) {
    super();
    const statusReactions = config.statusReactions;
    this._config = {
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
      statusReactions: statusReactions ? { ...statusReactions } : undefined,
    };
    this.statusReactionsEnabled = statusReactions?.enabled === true;
    this.statusReactionEmojis = resolveStatusReactionEmojis(statusReactions?.emojis);
    this.bot = new Bot(config.botToken);
    this.dedup = new TelegramUpdateDedup(config.botToken);
    this.typingManager = new TypingManager((peerId) => this.sendTypingAction(peerId));
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.bot.use(async (ctx, next) => {
      const updateId = ctx.update.update_id;
      if (this.dedup.isDuplicate(updateId)) {
        logger.info({ updateId }, "Skipping duplicate Telegram update");
        return;
      }
      this.dedup.markPending(updateId);
      try {
        await next();
      } finally {
        this.dedup.markDone(updateId);
      }
    });

    this.bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));

    this.bot.on("message:text", (ctx) =>
      handleMessage(
        ctx,
        this._config,
        this.id,
        this.botUsername,
        this.botId,
        (fileId) => this.getDownloadUrl(fileId),
        (msg) => this.emitMessage(msg),
      ),
    );
    this.bot.on("message:photo", (ctx) =>
      handleMessage(
        ctx,
        this._config,
        this.id,
        this.botUsername,
        this.botId,
        (fileId) => this.getDownloadUrl(fileId),
        (msg) => this.emitMessage(msg),
      ),
    );
    this.bot.on("message:document", (ctx) =>
      handleMessage(
        ctx,
        this._config,
        this.id,
        this.botUsername,
        this.botId,
        (fileId) => this.getDownloadUrl(fileId),
        (msg) => this.emitMessage(msg),
      ),
    );
    this.bot.on("message:voice", (ctx) =>
      handleMessage(
        ctx,
        this._config,
        this.id,
        this.botUsername,
        this.botId,
        (fileId) => this.getDownloadUrl(fileId),
        (msg) => this.emitMessage(msg),
      ),
    );
    this.bot.on("message:audio", (ctx) =>
      handleMessage(
        ctx,
        this._config,
        this.id,
        this.botUsername,
        this.botId,
        (fileId) => this.getDownloadUrl(fileId),
        (msg) => this.emitMessage(msg),
      ),
    );
    this.bot.on("message:video", (ctx) =>
      handleMessage(
        ctx,
        this._config,
        this.id,
        this.botUsername,
        this.botId,
        (fileId) => this.getDownloadUrl(fileId),
        (msg) => this.emitMessage(msg),
      ),
    );
    this.bot.on("callback_query:data", (ctx) =>
      handleCallback(ctx, this._config, this.id, (msg) => this.emitMessage(msg)),
    );

    this.bot.catch((err) => {
      logger.error({ err: err.error }, "Telegram bot error");
      this.emitError(err.error as Error);
    });
  }

  private async getDownloadUrl(fileId: string): Promise<string | undefined> {
    try {
      const file = await this.bot.api.getFile(fileId);
      return `https://api.telegram.org/file/bot${this._config.botToken}/${file.file_path}`;
    } catch (error) {
      logger.error({ error, fileId }, "Failed to get Telegram file URL");
      return undefined;
    }
  }

  async connect(): Promise<void> {
    if (this.runnerTask) {
      return;
    }

    this.setStatus("connecting");
    this.stopRequested = false;
    this.lastSupervisorError = null;
    this.connectAbortController = new AbortController();
    const signal = this.connectAbortController.signal;

    this.runnerTask = this.runPollingSupervisor(signal)
      .catch((error) => {
        if (this.stopRequested || signal.aborted) {
          return;
        }
        logger.error({ error }, "Telegram polling supervisor stopped with error");
        this.setStatus("error");
        this.emitError(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        this.runner = null;
        this.runnerTask = null;
        this.connectAbortController = null;
      });

    await this.waitForInitialConnection(signal);

    if (this.getStatus() === "error") {
      throw this.lastSupervisorError ?? new Error("Telegram channel failed to connect");
    }
  }

  private async registerCommands(): Promise<void> {
    const commands = [
      { command: "help", description: "Show help information" },
      { command: "status", description: "View current status" },
      { command: "whoami", description: "View my identity information" },
      { command: "context", description: "View context details" },
      { command: "prompt_digest", description: "View prompt digest" },
      { command: "models", description: "List available models" },
      { command: "skills", description: "List available skills" },
      { command: "switch", description: "Switch model (usage: /switch provider/model)" },
      { command: "new", description: "Start a new session" },
      { command: "reset", description: "Reset the current session" },
      { command: "compact", description: "Compact session context" },
      { command: "restart", description: "Restart runtime" },
      { command: "acp", description: "ACP session management (use /acp for help)" },
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
    this.typingManager.stopAll();
    this.stopRequested = true;
    this.connectAbortController?.abort();
    if (this.runner) {
      await this.runner.stop();
      this.runner = null;
    }
    if (this.runnerTask) {
      await this.runnerTask;
      this.runnerTask = null;
    }
    logger.info("Telegram bot disconnected");
    this.setStatus("disconnected");
  }

  private async runPollingSupervisor(signal: AbortSignal): Promise<void> {
    let restartAttempt = 0;

    while (!signal.aborted) {
      try {
        await this.ensureIdentity(signal);
        await this.registerCommands();
        await mkdir(process.env.DATA_DIR ?? ".data", { recursive: true });
        await this.dedup.load();

        this.runner = run(this.bot, {
          runner: {
            fetch: {
              timeout: this._config.polling?.timeoutSeconds,
            },
            maxRetryTime: this._config.polling?.maxRetryTimeMs,
            retryInterval: this._config.polling?.retryInterval,
            silent: this._config.polling?.silentRunnerErrors,
          },
        });

        restartAttempt = 0;
        this.setStatus("connected");
        logger.info({ botUsername: this.botUsername }, "Telegram bot connected");
        await this.runner.task();

        if (signal.aborted || this.stopRequested) {
          return;
        }

        throw new Error("Telegram polling runner exited unexpectedly");
      } catch (error) {
        if (signal.aborted || this.stopRequested) {
          return;
        }

        this.runner = null;

        const recoverable =
          isGetUpdatesConflict(error) ||
          isRecoverableTelegramNetworkError(error, { context: "polling" });
        if (!recoverable) {
          this.setStatus("error");
          this.lastSupervisorError = error instanceof Error ? error : new Error(String(error));
          throw this.lastSupervisorError;
        }

        restartAttempt += 1;
        const delayMs = this.computeRecoveryDelayMs(restartAttempt);
        this.setStatus("connecting");

        logger.warn(
          {
            error: formatTelegramError(error),
            attempt: restartAttempt,
            delayMs,
            recoverable: true,
          },
          "Recoverable Telegram polling failure; restarting",
        );

        await this.sleepWithSignal(delayMs, signal);
      }
    }
  }

  private async ensureIdentity(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return;
    }
    if (this.botUsername && this.botId) {
      return;
    }

    const me = await this.bot.api.getMe();
    this.botUsername = me.username?.trim().toLowerCase() || null;
    this.botId = me.id?.toString() || null;
  }

  private computeRecoveryDelayMs(attempt: number): number {
    const retryInterval = this._config.polling?.retryInterval;
    const baseMs = 1_000;
    const maxMs = 30_000;

    let delay = baseMs;
    if (typeof retryInterval === "number") {
      delay = retryInterval;
    } else if (retryInterval === "quadratic") {
      delay = baseMs * attempt * attempt;
    } else {
      delay = baseMs * 2 ** Math.max(0, attempt - 1);
    }

    const jitterFactor = 1 + (Math.random() * 0.4 - 0.2);
    return Math.max(baseMs, Math.min(maxMs, Math.round(delay * jitterFactor)));
  }

  private async sleepWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || delayMs <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async waitForInitialConnection(signal: AbortSignal): Promise<void> {
    const start = Date.now();
    const timeoutMs = 1_500;

    while (!signal.aborted) {
      if (this.getStatus() === "connected" || this.getStatus() === "error") {
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  override getCapabilities(): import("../types").ChannelCapabilities {
    return {
      media: true,
      polls: false,
      reactions: true,
      threads: true,
      editMessage: true,
      deleteMessage: true,
      implicitCurrentTarget: true,
      maxTextLength: 4096,
      maxCaptionLength: 1024,
      supportedActions: ["send_text", "send_media", "reply"],
    };
  }

  async send(peerId: string, message: OutboundMessage): Promise<string> {
    logger.info(
      {
        traceId: message.traceId,
        peerId,
        textChars: message.text?.length ?? 0,
        hasMedia: Boolean(message.media?.length),
        hasButtons: Boolean(message.buttons?.length),
      },
      "Telegram outbound send requested",
    );
    return sendMessage(this.bot, peerId, message, this._config.botToken);
  }

  async beginTyping(peerId: string): Promise<(() => Promise<void>) | void> {
    return this.typingManager.beginTyping(peerId, !!this.runner);
  }

  async react(messageId: string, peerId: string, emoji: string): Promise<void> {
    return reactToMessage(this.bot, messageId, peerId, emoji);
  }

  async setStatusReaction(
    peerId: string,
    messageId: string,
    status: StatusReaction,
    _payload?: StatusReactionPayload,
  ): Promise<void> {
    if (!this.statusReactionsEnabled) {
      return;
    }

    const emoji = this.statusReactionEmojis[status];
    if (!emoji) {
      return;
    }

    const reactionKey = `${peerId}:${messageId}`;
    const lastEmoji = this.statusReactionState.get(reactionKey);
    if (lastEmoji === emoji) {
      return;
    }

    await reactToMessage(this.bot, messageId, peerId, emoji);

    if (status === "done" || status === "error") {
      this.statusReactionState.delete(reactionKey);
      return;
    }

    this.statusReactionState.set(reactionKey, emoji);
  }

  async deleteMessage(messageId: string, peerId: string): Promise<void> {
    return deleteMsg(this.bot, messageId, peerId);
  }

  async editMessage(messageId: string, peerId: string, newText: string): Promise<void> {
    // Check if streaming is disabled
    if (this._config.streamMode === "off") {
      logger.debug({ peerId, messageId }, "Streaming disabled, skipping edit");
      return;
    }

    logger.info(
      {
        peerId,
        messageId,
        textChars: newText.length,
        streamMode: this._config.streamMode,
      },
      "Telegram outbound edit requested",
    );
    return editMsg(this.bot, messageId, peerId, newText);
  }

  private async sendTypingAction(peerId: string): Promise<void> {
    try {
      await this.bot.api.sendChatAction(peerId, "typing");
    } catch (error) {
      logger.warn({ error, peerId }, "Failed to send Telegram typing indicator");
    }
  }
}
