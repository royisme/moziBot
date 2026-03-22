/**
 * WechatPlugin — WeChat (ilink bot) channel for mozi.
 * Extends BaseChannelPlugin following the same pattern as TelegramPlugin.
 */

import { logger } from "../../../../logger";
import { BaseChannelPlugin } from "../plugin";
import type { ChannelCapabilities, OutboundMessage } from "../types";
import { getConfig, sendTyping, DEFAULT_BASE_URL } from "./api";
import { getContextToken } from "./inbound";
import { runWechatMonitor } from "./monitor";
import { sendText } from "./send";

export interface WechatPluginConfig {
  /** ilink bot token from QR login */
  token: string;
  /** Optional allowlist of WeChat user IDs (from_user_id values). Empty = allow all. */
  allowFrom?: string[];
  /** Override API base URL. Default: https://ilinkai.weixin.qq.com */
  baseUrl?: string;
  /** Long-poll timeout in seconds. Default: 35 */
  pollingTimeoutSeconds?: number;
}

export class WechatPlugin extends BaseChannelPlugin {
  readonly id = "wechat";
  readonly name = "WeChat";

  private _config: WechatPluginConfig;
  private abortController: AbortController | null = null;
  private monitorTask: Promise<void> | null = null;
  private stopRequested = false;

  constructor(config: WechatPluginConfig) {
    super();
    this._config = {
      ...config,
      allowFrom: (config.allowFrom ?? []).map((id) => id.toString()),
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      pollingTimeoutSeconds: config.pollingTimeoutSeconds ?? 35,
    };
  }

  private get baseUrl(): string {
    return this._config.baseUrl ?? DEFAULT_BASE_URL;
  }

  async connect(): Promise<void> {
    if (this.monitorTask) {
      return;
    }

    this.setStatus("connecting");
    this.stopRequested = false;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    this.monitorTask = runWechatMonitor({
      channelId: this.id,
      baseUrl: this.baseUrl,
      token: this._config.token,
      allowFrom: this._config.allowFrom,
      longPollTimeoutSeconds: this._config.pollingTimeoutSeconds,
      abortSignal: signal,
      emitMessage: (msg) => this.emitMessage(msg),
    })
      .catch((err) => {
        if (this.stopRequested || signal.aborted) {
          return;
        }
        logger.error({ err }, "wechat monitor stopped with error");
        this.setStatus("error");
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        this.monitorTask = null;
        this.abortController = null;
      });

    // Brief wait for initial connection — wechat long-poll connects immediately
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    if (this.getStatus() === "connecting") {
      this.setStatus("connected");
      logger.info({ baseUrl: this.baseUrl }, "wechat channel connected");
    }
  }

  async disconnect(): Promise<void> {
    this.stopRequested = true;
    this.abortController?.abort();
    if (this.monitorTask) {
      await this.monitorTask.catch(() => {});
      this.monitorTask = null;
    }
    this.setStatus("disconnected");
    logger.info("wechat channel disconnected");
  }

  async send(peerId: string, message: OutboundMessage): Promise<string> {
    const contextToken = getContextToken(peerId);
    if (!contextToken) {
      logger.warn({ peerId }, "wechat send: contextToken missing, cannot send reply");
      return "";
    }

    const text = message.text ?? "";
    if (!text) {
      logger.debug({ peerId }, "wechat send: empty text, skipping");
      return "";
    }

    logger.info(
      { peerId, textChars: text.length, traceId: message.traceId },
      "wechat outbound send requested",
    );

    return sendText({
      peerId,
      text,
      contextToken,
      baseUrl: this.baseUrl,
      token: this._config.token,
    });
  }

  async beginTyping(peerId: string): Promise<(() => Promise<void>) | void> {
    const contextToken = getContextToken(peerId);

    let typingTicket: string | undefined;
    try {
      const configResp = await getConfig({
        baseUrl: this.baseUrl,
        token: this._config.token,
        ilinkUserId: peerId,
        contextToken,
      });
      typingTicket = configResp.typing_ticket;
    } catch (err) {
      logger.debug({ err, peerId }, "wechat beginTyping: getConfig failed, skipping typing");
      return;
    }

    if (!typingTicket) {
      logger.debug({ peerId }, "wechat beginTyping: no typing_ticket, skipping typing");
      return;
    }

    // Send initial typing indicator
    const doTyping = async (status: 1 | 2) => {
      try {
        await sendTyping({
          baseUrl: this.baseUrl,
          token: this._config.token,
          body: {
            ilink_user_id: peerId,
            typing_ticket: typingTicket,
            status,
          },
        });
      } catch (err) {
        logger.debug({ err, peerId, status }, "wechat sendTyping failed (non-fatal)");
      }
    };

    await doTyping(1);

    // Keepalive every 5 s
    const interval = setInterval(() => {
      doTyping(1).catch(() => {});
    }, 5_000);

    // Return stop callback
    return async () => {
      clearInterval(interval);
      await doTyping(2);
    };
  }

  override getCapabilities(): ChannelCapabilities {
    return {
      media: false,
      polls: false,
      reactions: false,
      threads: false,
      editMessage: false,
      deleteMessage: false,
      implicitCurrentTarget: true,
      maxTextLength: 4000,
      supportedActions: ["send_text", "reply"],
    };
  }
}
