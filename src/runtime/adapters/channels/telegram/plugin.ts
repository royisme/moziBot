import { run, sequentialize } from "@grammyjs/runner";
import { Bot } from "grammy";
import type { OutboundMessage } from "../types";
import { logger } from "../../../../logger";
import { BaseChannelPlugin } from "../plugin";
import {
  formatTelegramError,
  isGetUpdatesConflict,
  isRecoverableTelegramNetworkError,
} from "./network-errors";
import { normalizeGroupPolicies, type TelegramGroupPolicyConfig } from "./access";
import { handleMessage, handleCallback } from "./handlers";
import { sendMessage, reactToMessage, deleteMsg, editMsg } from "./send";
import { TypingManager } from "./typing";

export interface TelegramPluginConfig {
  botToken: string;
  allowedChats?: string[]; // Optional whitelist
  dmPolicy?: "open" | "allowlist";
  groupPolicy?: "open" | "allowlist";
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

export class TelegramPlugin extends BaseChannelPlugin {
  readonly id = "telegram";
  readonly name = "Telegram";

  private bot: Bot;
  private config: TelegramPluginConfig;
  private runner: ReturnType<typeof run> | null = null;
  private runnerTask: Promise<void> | null = null;
  private connectAbortController: AbortController | null = null;
  private stopRequested = false;
  private lastSupervisorError: Error | null = null;
  private botUsername: string | null = null;
  private botId: string | null = null;
  private typingManager: TypingManager;

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
    this.typingManager = new TypingManager((peerId) => this.sendTypingAction(peerId));
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));

    this.bot.on("message:text", (ctx) =>
      handleMessage(ctx, this.config, this.id, this.botUsername, this.botId,
        (fileId) => this.getDownloadUrl(fileId),
        (msg) => this.emitMessage(msg)),
    );
    this.bot.on("message:photo", (ctx) =>
      handleMessage(ctx, this.config, this.id, this.botUsername, this.botId,
        (fileId) => this.getDownloadUrl(fileId),
        (msg) => this.emitMessage(msg)),
    );
    this.bot.on("message:document", (ctx) =>
      handleMessage(ctx, this.config, this.id, this.botUsername, this.botId,
        (fileId) => this.getDownloadUrl(fileId),
        (msg) => this.emitMessage(msg)),
    );
    this.bot.on("message:voice", (ctx) =>
      handleMessage(ctx, this.config, this.id, this.botUsername, this.botId,
        (fileId) => this.getDownloadUrl(fileId),
        (msg) => this.emitMessage(msg)),
    );
    this.bot.on("message:audio", (ctx) =>
      handleMessage(ctx, this.config, this.id, this.botUsername, this.botId,
        (fileId) => this.getDownloadUrl(fileId),
        (msg) => this.emitMessage(msg)),
    );
    this.bot.on("message:video", (ctx) =>
      handleMessage(ctx, this.config, this.id, this.botUsername, this.botId,
        (fileId) => this.getDownloadUrl(fileId),
        (msg) => this.emitMessage(msg)),
    );
    this.bot.on("callback_query:data", (ctx) =>
      handleCallback(ctx, this.config, this.id, (msg) => this.emitMessage(msg)),
    );

    this.bot.catch((err) => {
      logger.error({ err: err.error }, "Telegram bot error");
      this.emitError(err.error as Error);
    });
  }

  private async getDownloadUrl(fileId: string): Promise<string | undefined> {
    try {
      const file = await this.bot.api.getFile(fileId);
      return `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;
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
    const retryInterval = this.config.polling?.retryInterval;
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

  async send(peerId: string, message: OutboundMessage): Promise<string> {
    return sendMessage(this.bot, peerId, message, this.config.botToken);
  }

  async beginTyping(peerId: string): Promise<(() => Promise<void>) | void> {
    return this.typingManager.beginTyping(peerId, !!this.runner);
  }

  async react(messageId: string, peerId: string, emoji: string): Promise<void> {
    return reactToMessage(this.bot, messageId, peerId, emoji);
  }

  async deleteMessage(messageId: string, peerId: string): Promise<void> {
    return deleteMsg(this.bot, messageId, peerId);
  }

  async editMessage(messageId: string, peerId: string, newText: string): Promise<void> {
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
