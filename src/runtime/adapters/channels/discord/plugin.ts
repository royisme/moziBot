import { Client, MessageCreateListener, ReadyListener } from "@buape/carbon";
import { GatewayIntents, GatewayPlugin } from "@buape/carbon/gateway";
import { Routes, type APIAttachment, type APIEmbed } from "discord-api-types/v10";
import { EventEmitter } from "node:events";
import type {
  InboundMessage,
  MediaAttachment,
  OutboundMessage,
  StatusReaction,
  StatusReactionPayload,
} from "../types";
import { logger } from "../../../../logger";
import { BaseChannelPlugin } from "../plugin";
import { resolveStatusReactionEmojis, type StatusReactionEmojis } from "../status-reactions";
import {
  type AccessPolicy,
  type DiscordGuildPolicyConfig,
  isBotMentioned,
  isCommandText,
  isRoleAllowed,
  isSenderAllowed,
  normalizeAllowList,
  normalizeGuildPolicies,
} from "./access";

const READY_TIMEOUT_MS = 20_000;
const MAX_GATEWAY_RECONNECT_ATTEMPTS = 20;

type CarbonMessageCreateEvent = Parameters<MessageCreateListener["handle"]>[0];
type CarbonReadyEvent = Parameters<ReadyListener["handle"]>[0];

interface StatusReactionsConfig {
  enabled?: boolean;
  emojis?: StatusReactionEmojis;
}

export interface DiscordPluginConfig {
  botToken: string;
  allowedGuilds?: string[];
  allowedChannels?: string[];
  dmPolicy?: AccessPolicy;
  groupPolicy?: AccessPolicy;
  allowFrom?: string[];
  guilds?: Record<string, DiscordGuildPolicyConfig>;
  statusReactions?: StatusReactionsConfig;
}

class CarbonReadyBridge extends ReadyListener {
  constructor(private readonly onReady: (data: CarbonReadyEvent) => void) {
    super();
  }

  async handle(data: CarbonReadyEvent, _client: Client): Promise<void> {
    this.onReady(data);
  }
}

class CarbonMessageBridge extends MessageCreateListener {
  constructor(
    private readonly onMessage: (data: CarbonMessageCreateEvent, client: Client) => Promise<void>,
  ) {
    super();
  }

  async handle(data: CarbonMessageCreateEvent, client: Client): Promise<void> {
    await this.onMessage(data, client);
  }
}

export class DiscordPlugin extends BaseChannelPlugin {
  readonly id = "discord";
  readonly name = "Discord";

  private client: Client | null = null;
  private gateway: GatewayPlugin | null = null;
  private config: DiscordPluginConfig;
  private botId: string | null = null;
  private botUsername: string | null = null;
  private disabledReason?: string;
  private connectInFlight: Promise<void> | null = null;
  private statusReactionsEnabled: boolean;
  private statusReactionEmojis: Record<StatusReaction, string>;
  private statusReactionState = new Map<string, string>();

  constructor(config: DiscordPluginConfig) {
    super();
    const statusReactions = config.statusReactions;
    this.config = {
      ...config,
      botToken: normalizeDiscordToken(config.botToken),
      allowFrom: normalizeAllowList(config.allowFrom),
      guilds: normalizeGuildPolicies(config.guilds),
      statusReactions: statusReactions ? { ...statusReactions } : undefined,
    };
    this.statusReactionsEnabled = statusReactions?.enabled === true;
    this.statusReactionEmojis = resolveStatusReactionEmojis(statusReactions?.emojis);
  }

  async connect(): Promise<void> {
    if (this.connectInFlight) {
      return this.connectInFlight;
    }

    const run = this.connectInternal();
    this.connectInFlight = run;
    return run.finally(() => {
      this.connectInFlight = null;
    });
  }

  private async connectInternal(): Promise<void> {
    if (this.status === "connecting" || this.status === "connected") {
      return;
    }
    if (this.disabledReason) {
      throw new Error(this.disabledReason);
    }
    this.setStatus("connecting");

    let readyTimeout: ReturnType<typeof setTimeout> | null = null;
    let settleReady: ((result: { tag?: string; error?: Error }) => void) | null = null;

    try {
      const readyPromise = new Promise<{ tag?: string; error?: Error }>((resolve) => {
        settleReady = resolve;
      });

      const listeners = [
        new CarbonReadyBridge((event) => {
          this.botId = event.user?.id?.toString() ?? null;
          this.botUsername = event.user?.username?.toLowerCase() ?? null;
          const tag = formatUserTag(event.user?.username, event.user?.discriminator);
          settleReady?.({ tag });
        }),
        new CarbonMessageBridge(async (event) => {
          await this.handleMessage(event);
        }),
      ];

      const gateway = new GatewayPlugin({
        intents:
          GatewayIntents.Guilds |
          GatewayIntents.GuildMessages |
          GatewayIntents.MessageContent |
          GatewayIntents.DirectMessages,
        reconnect: { maxAttempts: MAX_GATEWAY_RECONNECT_ATTEMPTS },
      });

      const applicationId = await fetchApplicationId(this.config.botToken);

      const client = new Client(
        {
          baseUrl: "http://localhost",
          clientId: applicationId,
          publicKey: "unused",
          token: this.config.botToken,
          disableDeployRoute: true,
          disableEventsRoute: true,
          disableInteractionsRoute: true,
        },
        { listeners },
        [gateway],
      );

      const gatewayEmitter = getGatewayEmitter(gateway);
      const onGatewayError = (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (this.isAuthFailureError(error)) {
          this.handleAuthFailure("gatewayError", error);
        }
        logger.error({ err: error }, "Discord gateway error");
        this.emitError(error);
        settleReady?.({ error });
      };
      gatewayEmitter?.on("error", onGatewayError);

      this.client = client;
      this.gateway = gateway;

      readyTimeout = setTimeout(() => {
        settleReady?.({ error: new Error("Discord gateway ready timeout") });
      }, READY_TIMEOUT_MS);

      const readyResult = await readyPromise;
      if (readyResult.error) {
        throw readyResult.error;
      }

      this.setStatus("connected");
      logger.info(`Discord bot ready as ${readyResult.tag ?? "unknown"}`);

      if (readyTimeout) {
        clearTimeout(readyTimeout);
        readyTimeout = null;
      }
      gatewayEmitter?.removeListener("error", onGatewayError);
    } catch (err) {
      if (readyTimeout) {
        clearTimeout(readyTimeout);
      }
      this.setStatus("error");
      await this.disconnect().catch(() => {});
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    try {
      if (this.gateway) {
        const reconnectOptions = (
          this.gateway as unknown as { options?: { reconnect?: { maxAttempts: number } } }
        ).options;
        if (reconnectOptions) {
          reconnectOptions.reconnect = { maxAttempts: 0 };
        }
      }
      this.gateway?.disconnect();
    } finally {
      this.gateway = null;
      this.client = null;
      this.setStatus("disconnected");
      logger.info("Discord bot disconnected");
    }
  }

  async send(peerId: string, message: OutboundMessage): Promise<string> {
    if (!this.client) {
      throw new Error("Discord client is not connected");
    }

    const mediaUrls = (message.media ?? [])
      .map((item) => item.url)
      .filter((url): url is string => !!url);
    if ((message.media ?? []).some((item) => !item.url)) {
      logger.warn(
        "Discord plugin currently supports media URLs only; unsupported attachment skipped",
      );
    }

    const content = [message.text?.trim() ?? "", ...mediaUrls].filter(Boolean).join("\n").trim();
    if (!content) {
      throw new Error("Discord outbound message is empty");
    }

    const body: {
      content: string;
      message_reference?: { message_id: string; fail_if_not_exists: boolean };
    } = { content };

    if (message.replyToId) {
      body.message_reference = {
        message_id: message.replyToId,
        fail_if_not_exists: false,
      };
    }

    const sent = (await this.client.rest.post(Routes.channelMessages(peerId), {
      body,
    })) as { id?: string };

    return sent.id ?? "unknown";
  }

  async setStatusReaction(
    peerId: string,
    messageId: string,
    status: StatusReaction,
    _payload?: StatusReactionPayload,
  ): Promise<void> {
    if (!this.client || !this.statusReactionsEnabled) {
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

    try {
      const encoded = normalizeDiscordReactionEmoji(emoji);
      await this.client.rest.put(Routes.channelMessageOwnReaction(peerId, messageId, encoded));
    } catch (error) {
      logger.warn(
        { error, peerId, messageId, emoji, status },
        "Failed to set Discord status reaction",
      );
      return;
    }

    if (lastEmoji && lastEmoji !== emoji) {
      try {
        const encodedPrev = normalizeDiscordReactionEmoji(lastEmoji);
        await this.client.rest.delete(
          Routes.channelMessageOwnReaction(peerId, messageId, encodedPrev),
        );
      } catch (error) {
        logger.warn(
          { error, peerId, messageId, emoji: lastEmoji, status },
          "Failed to remove previous Discord status reaction",
        );
      }
    }

    if (status === "done" || status === "error") {
      this.statusReactionState.delete(reactionKey);
      return;
    }

    this.statusReactionState.set(reactionKey, emoji);
  }

  private async handleMessage(event: CarbonMessageCreateEvent): Promise<void> {
    const author = event.author;
    const msg = event.message;

    if (!author || author.bot) {
      return;
    }

    const guildId = event.guild_id ?? event.guild?.id;
    const channelId = msg.channelId;
    const memberRoleIds = Array.isArray(event.rawMember?.roles)
      ? event.rawMember.roles.map((roleId: string) => roleId.toString())
      : [];

    if (this.config.allowedGuilds && guildId && !this.config.allowedGuilds.includes(guildId)) {
      return;
    }

    if (this.config.allowedChannels && !this.config.allowedChannels.includes(channelId)) {
      return;
    }

    const peerType = guildId ? "group" : "dm";

    if (peerType === "dm" && this.config.dmPolicy === "allowlist") {
      if (!isSenderAllowed(this.config.allowFrom, author.id, author.username)) {
        logger.info({ channelId, senderId: author.id }, "Discord DM dropped by dmPolicy=allowlist");
        return;
      }
    }

    if (peerType === "group") {
      const guildConfig = guildId ? this.config.guilds?.[guildId] : undefined;
      const effectiveAllowFrom = guildConfig?.allowFrom || this.config.allowFrom;
      const groupPolicy = this.config.groupPolicy ?? "open";
      const roleAllowList = guildConfig?.allowRoles;

      if (roleAllowList && roleAllowList.length > 0) {
        if (!isRoleAllowed(roleAllowList, memberRoleIds)) {
          logger.info(
            { channelId, guildId, senderId: author.id },
            "Discord group message dropped by role allowlist",
          );
          return;
        }
      }

      if (
        groupPolicy === "allowlist" &&
        !isSenderAllowed(effectiveAllowFrom, author.id, author.username)
      ) {
        logger.info(
          { channelId, guildId, senderId: author.id },
          "Discord group message dropped by groupPolicy=allowlist",
        );
        return;
      }

      if (guildConfig?.requireMention === true && !isCommandText(msg.content)) {
        const mentioned = isBotMentioned({
          text: msg.content,
          mentions: msg.mentions ?? [],
          botId: this.botId,
          botUsername: this.botUsername,
        });
        if (!mentioned) {
          logger.info(
            { channelId, guildId, senderId: author.id },
            "Discord group message dropped by requireMention=true",
          );
          return;
        }
      }
    }

    // Extract only serializable data from the event to avoid cyclic structure issues
    // Carbon event objects contain circular references (client, guild, etc.) that cannot be JSON.stringify'd
    const rawData = {
      messageId: msg.id,
      channelId: msg.channelId,
      guildId: guildId,
      authorId: author.id,
      authorUsername: author.username,
      authorDiscriminator: author.discriminator,
      authorBot: author.bot,
      content: msg.content,
      timestamp: msg.timestamp,
      editedTimestamp: msg.editedTimestamp,
      attachments: (msg.attachments ?? []).map((att: APIAttachment) => ({
        id: att.id,
        filename: att.filename,
        contentType: att.content_type,
        size: att.size,
        url: att.url,
        proxyUrl: att.proxy_url,
      })),
      embeds: (msg.embeds ?? []).map((embed: APIEmbed) => ({
        title: embed.title,
        type: embed.type,
        description: embed.description,
        url: embed.url,
      })),
      mentionUserIds: (msg.mentions ?? [])
        .map((mention: { id?: string }) => mention.id)
        .filter((id: string | undefined): id is string => Boolean(id)),
      mentionRoles: msg.mentionRoles ?? [],
      mentionEveryone: msg.mentionEveryone,
      memberRoleIds,
      messageReference: msg.messageReference
        ? {
            message_id: msg.messageReference.message_id,
            channel_id: msg.messageReference.channel_id,
            guild_id: msg.messageReference.guild_id,
          }
        : undefined,
      flags: msg.flags,
      type: msg.type,
    };

    const inbound: InboundMessage = {
      id: msg.id,
      channel: this.id,
      peerId: channelId,
      peerType,
      senderId: author.id,
      senderName: author.username,
      text: msg.content,
      media: mapAttachments(msg.attachments),
      replyToId: msg.messageReference?.message_id || undefined,
      timestamp: new Date(msg.timestamp),
      raw: rawData,
    };

    this.emitMessage(inbound);
  }

  private isAuthFailureError(error: unknown): boolean {
    const message = toError(error).message.toLowerCase();
    return (
      message.includes("4004") ||
      message.includes("authentication failed") ||
      message.includes("invalid token")
    );
  }

  private handleAuthFailure(source: string, error: unknown): void {
    if (this.disabledReason) {
      return;
    }
    this.disabledReason =
      "Discord authentication failed (token invalid/reset). Please update botToken and restart runtime.";
    logger.error(
      { source, err: toError(error) },
      "Discord authentication failed; disabling reconnect to avoid connection storm",
    );
    if (this.gateway) {
      const reconnectOptions = (
        this.gateway as unknown as { options?: { reconnect?: { maxAttempts: number } } }
      ).options;
      if (reconnectOptions) {
        reconnectOptions.reconnect = { maxAttempts: 0 };
      }
    }
    this.setStatus("error");
    this.emitError(new Error(this.disabledReason));
    void this.disconnect()
      .catch(() => {})
      .finally(() => {
        this.setStatus("error");
      });
  }
}

function mapAttachments(attachments: APIAttachment[] | undefined): MediaAttachment[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }
  return attachments.map((att) => ({
    type: mapAttachmentType(att.content_type || undefined),
    url: att.url,
    caption: undefined,
    filename: att.filename,
    mimeType: att.content_type || undefined,
    byteSize: att.size,
  }));
}

function mapAttachmentType(contentType: string | undefined): MediaAttachment["type"] {
  if (!contentType) {
    return "document";
  }
  if (contentType.startsWith("image/")) {
    return "photo";
  }
  if (contentType.startsWith("video/")) {
    return "video";
  }
  if (contentType.startsWith("audio/")) {
    return "audio";
  }
  return "document";
}

function normalizeDiscordToken(raw: string): string {
  return raw.trim().replace(/^Bot\s+/i, "");
}

function formatUserTag(username: string | undefined, discriminator: string | undefined): string {
  const safeName = username?.trim() || "unknown";
  if (!discriminator || discriminator === "0") {
    return safeName;
  }
  return `${safeName}#${discriminator}`;
}

function getGatewayEmitter(gateway?: GatewayPlugin | null): EventEmitter | undefined {
  return (gateway as unknown as { emitter?: EventEmitter } | undefined)?.emitter;
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function normalizeDiscordReactionEmoji(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("emoji required");
  }
  const customMatch = trimmed.match(/^<a?:([^:>]+):(\d+)>$/);
  const identifier = customMatch
    ? `${customMatch[1]}:${customMatch[2]}`
    : trimmed.replace(/[\uFE0E\uFE0F]/g, "");
  return encodeURIComponent(identifier);
}

async function fetchApplicationId(token: string): Promise<string> {
  const response = await fetch("https://discord.com/api/v10/oauth2/applications/@me", {
    headers: {
      Authorization: `Bot ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Discord API /oauth2/applications/@me failed (${response.status})`);
  }

  const data = (await response.json()) as { id?: string };
  if (!data.id) {
    throw new Error("Discord API returned no application id");
  }

  return data.id;
}
