import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import {
  Client,
  Command,
  CommandInteraction,
  type MessagePayloadFile,
  type MessagePayloadObject,
  MessageCreateListener,
  ReadyListener,
  serializePayload,
} from "@buape/carbon";
import { GatewayIntents, GatewayPlugin } from "@buape/carbon/gateway";
import {
  ApplicationCommandOptionType,
  ButtonStyle,
  ChannelType,
  ComponentType,
  InteractionType,
  Routes,
  type APIAttachment,
  type APIEmbed,
} from "discord-api-types/v10";
import { logger } from "../../../../logger";
import { chunkTextWithMode, getChannelTextLimit } from "../../../../utils/text-chunk";
import { BaseChannelPlugin } from "../plugin";
import { resolveStatusReactionEmojis, type StatusReactionEmojis } from "../status-reactions";
import type {
  InboundMessage,
  MediaAttachment,
  OutboundMessage,
  StatusReaction,
  StatusReactionPayload,
} from "../types";
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
const DISCORD_SUPPRESS_NOTIFICATIONS_FLAG = 1 << 12;
const DISCORD_TEXT_LIMIT = getChannelTextLimit("discord");
const DISCORD_MEDIA_URL_MAX_BYTES = 52_428_800;

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

  /**
   * Register ACP slash commands for Discord
   */
  private async registerAcpCommands(client: Client): Promise<void> {
    // Store reference to plugin for use in command handler
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const outerPlugin = this;

    // ACP parent command with subcommands
    class AcpCommand extends Command {
      name = "acp";
      description = "Manage ACP (Agent Client Protocol) sessions";
      defer = true;
      options = [
        {
          name: "spawn",
          description: "Spawn a new ACP session",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "backend",
              description: "The backend to use (e.g., openai-codex)",
              type: ApplicationCommandOptionType.String,
              required: true,
            },
            {
              name: "agent",
              description: "Agent ID to use",
              type: ApplicationCommandOptionType.String,
              required: false,
            },
            {
              name: "mode",
              description: "Session mode (persistent or oneshot)",
              type: ApplicationCommandOptionType.String,
              required: false,
              choices: [
                { name: "Persistent", value: "persistent" },
                { name: "Oneshot", value: "oneshot" },
              ],
            },
            {
              name: "cwd",
              description: "Working directory",
              type: ApplicationCommandOptionType.String,
              required: false,
            },
          ],
        },
        {
          name: "status",
          description: "Show status of an ACP session",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "session",
              description: "Session key or label",
              type: ApplicationCommandOptionType.String,
              required: true,
            },
          ],
        },
        {
          name: "cancel",
          description: "Cancel an ACP session",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "session",
              description: "Session key or label",
              type: ApplicationCommandOptionType.String,
              required: true,
            },
          ],
        },
        {
          name: "list",
          description: "List all ACP sessions",
          type: ApplicationCommandOptionType.Subcommand,
        },
      ];

      // Spawn subcommand
      async run(interaction: CommandInteraction): Promise<void> {
        const subcommand =
          interaction.options.getSubcommandGroup(false) ||
          interaction.options.getSubcommand(false) ||
          "";

        const args = this.buildArgsFromInteraction(interaction, subcommand);
        await this.handleAcpCommand(interaction, subcommand, args, outerPlugin);
      }

      private buildArgsFromInteraction(
        interaction: CommandInteraction,
        subcommand: string,
      ): string {
        const parts: string[] = [subcommand];

        // Get all options
        const backend = interaction.options.getString("backend");
        const agent = interaction.options.getString("agent");
        const mode = interaction.options.getString("mode");
        const cwd = interaction.options.getString("cwd");
        const session = interaction.options.getString("session");

        if (backend) {
          parts.push(backend);
        }
        if (agent) {
          parts.push(`--agent=${agent}`);
        }
        if (mode) {
          parts.push(`--mode=${mode}`);
        }
        if (cwd) {
          parts.push(`--cwd=${cwd}`);
        }
        if (session) {
          parts.push(session);
        }

        return parts.join(" ");
      }

      private async handleAcpCommand(
        interaction: CommandInteraction,
        subcommand: string,
        args: string,
        plugin: DiscordPlugin,
      ): Promise<void> {
        // Build a synthetic inbound message for the command handler
        const inbound: InboundMessage = {
          id: interaction.id,
          channel: plugin.id,
          peerId: interaction.channel?.id || "unknown",
          peerType: interaction.guildId ? "group" : "dm",
          senderId: interaction.user.id,
          senderName: interaction.user.username,
          text: `/acp ${args}`,
          timestamp: new Date(),
          raw: {
            interactionId: interaction.id,
            userId: interaction.user.id,
            channelId: interaction.channel?.id,
            guildId: interaction.guildId,
          },
        };

        // Emit the message for command processing
        plugin.emitInboundMessage(inbound);

        // Acknowledge the interaction
        await interaction.reply({
          content: `Processing /acp ${args}...`,
          ephemeral: true,
        });
      }
    }

    // Register commands with Carbon client
    try {
      const commands = [new AcpCommand()];
      for (const cmd of commands) {
        client.commands.push(cmd);
      }

      // Register simple bot commands as Discord slash commands
      this.registerSimpleSlashCommands(client);

      await client.handleDeployRequest();
      logger.info("Discord slash commands registered");
    } catch (error) {
      logger.warn({ error }, "Failed to register Discord slash commands");
    }
  }

  /**
   * Register simple bot commands (/models, /switch, /new, /reset, /help, /stop, /compact)
   * as Discord slash commands. Each emits a synthetic InboundMessage.
   */
  private registerSimpleSlashCommands(client: Client): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const plugin = this;

    const simpleCommands: Array<{
      name: string;
      description: string;
      options?: Array<{
        name: string;
        description: string;
        type: number;
        required?: boolean;
      }>;
    }> = [
      { name: "models", description: "List available AI models" },
      {
        name: "switch",
        description: "Switch to a different AI model",
        options: [
          {
            name: "model",
            description: "Model alias or provider/model name",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
      { name: "new", description: "Start a new session" },
      { name: "reset", description: "Reset the current session" },
      { name: "help", description: "Show available commands" },
      { name: "stop", description: "Interrupt the active run" },
      { name: "compact", description: "Compact session context" },
      { name: "status", description: "View current status" },
      { name: "skills", description: "List available skills" },
    ];

    for (const def of simpleCommands) {
      const cmdDef = def;
      class SimpleCmd extends Command {
        name = cmdDef.name;
        description = cmdDef.description;
        defer = false;
        options = cmdDef.options ?? [];

        async run(interaction: CommandInteraction): Promise<void> {
          let args = "";
          if (cmdDef.options) {
            for (const opt of cmdDef.options) {
              const val = interaction.options.getString(opt.name);
              if (val) {
                args += (args ? " " : "") + val;
              }
            }
          }

          // Cast to access raw Discord properties not exposed by Carbon's CommandInteraction type
          const raw = interaction as unknown as {
            id: string;
            guildId?: string;
            user?: { id: string; username?: string };
            channel?: { id?: string };
          };
          const inbound: InboundMessage = {
            id: raw.id ?? "unknown",
            channel: plugin.id,
            peerId: raw.channel?.id || interaction.channel?.id || "unknown",
            peerType: raw.guildId ? "group" : "dm",
            senderId: raw.user?.id ?? "unknown",
            senderName: raw.user?.username,
            text: `/${cmdDef.name}${args ? " " + args : ""}`,
            timestamp: new Date(),
            raw: {
              interactionId: raw.id,
              userId: raw.user?.id,
              channelId: raw.channel?.id || interaction.channel?.id,
              guildId: raw.guildId,
            },
          };

          plugin.emitInboundMessage(inbound);

          await interaction.reply({
            content: `Processing /${cmdDef.name}${args ? " " + args : ""}...`,
            ephemeral: true,
          });
        }
      }
      client.commands.push(new SimpleCmd());
    }
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
          disableInteractionsRoute: false,
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

      // Register ACP slash commands
      await this.registerAcpCommands(client);

      // Intercept button interactions to route command-like custom_ids as InboundMessages
      this.installButtonInteractionInterceptor(client);

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

  override getCapabilities(): import("../types").ChannelCapabilities {
    return {
      media: true,
      polls: true,
      reactions: true,
      threads: true,
      editMessage: false,
      deleteMessage: false,
      implicitCurrentTarget: true,
      maxTextLength: DISCORD_TEXT_LIMIT,
      supportedActions: ["send_text", "send_media", "reply"],
    };
  }

  async send(peerId: string, message: OutboundMessage): Promise<string> {
    const media = message.media ?? [];
    const { files, urls } = await resolveOutboundFiles(media);

    const baseText = resolveOutboundText(message, media);
    const content = [baseText, ...urls].filter(Boolean).join("\n").trim();
    if (!content && files.length === 0 && !message.poll) {
      throw new Error("Discord outbound message is empty");
    }

    const chunks = content ? chunkTextWithMode(content, DISCORD_TEXT_LIMIT, "paragraph") : [""];

    if (message.webhookUrl) {
      return this.sendViaWebhook(message.webhookUrl, chunks, message);
    }

    if (!this.client) {
      throw new Error("Discord client is not connected");
    }

    const flags = message.silent ? DISCORD_SUPPRESS_NOTIFICATIONS_FLAG : undefined;
    let lastId = "unknown";

    for (const [index, chunk] of chunks.entries()) {
      const isFirst = index === 0;
      const payload: MessagePayloadObject = {};
      if (chunk.trim()) {
        payload.content = chunk;
      }
      if (flags !== undefined) {
        payload.flags = flags;
      }
      if (isFirst && files.length > 0) {
        payload.files = files;
      }

      const body = serializePayload(payload);

      // Attach inline buttons as Discord ActionRow components
      if (isFirst && message.buttons && message.buttons.length > 0) {
        (body as Record<string, unknown>).components = message.buttons
          .slice(0, 5) // Discord max 5 action rows
          .map((row) => ({
            type: ComponentType.ActionRow,
            components: row.slice(0, 5).map((btn) => {
              if (btn.url) {
                return {
                  type: ComponentType.Button,
                  style: ButtonStyle.Link,
                  label: btn.text.slice(0, 80),
                  url: btn.url,
                };
              }
              return {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                label: btn.text.slice(0, 80),
                custom_id: (btn.callbackData ?? btn.text).slice(0, 100),
              };
            }),
          }));
      }
      if (isFirst && message.replyToId) {
        (
          body as { message_reference?: { message_id: string; fail_if_not_exists: boolean } }
        ).message_reference = {
          message_id: message.replyToId,
          fail_if_not_exists: false,
        };
      }
      if (isFirst && message.poll) {
        (body as Record<string, unknown>).poll = {
          question: { text: message.poll.question.slice(0, 300) },
          answers: message.poll.options.slice(0, 10).map((option) => ({
            poll_media: { text: option.slice(0, 55) },
          })),
          allow_multiselect: message.poll.allowMultiselect ?? false,
          duration: Math.min(Math.max(message.poll.durationHours ?? 24, 1), 168),
        };
      }

      const sent = (await this.client.rest.post(Routes.channelMessages(peerId), {
        body,
      })) as { id?: string };
      lastId = sent.id ?? lastId;
    }

    return lastId;
  }

  /**
   * Create a new thread or forum post in a Discord channel.
   * Used for forum channels (type 15) or creating private threads in text channels (type 12).
   * @param channelId The parent channel ID where the thread/forum post will be created
   * @param name Thread name or forum post title (max 100 chars)
   * @param messageId Optional message ID to create thread from (for GUILD_TEXT channels)
   * @returns The created thread/forum post channel ID
   */
  async createThread(channelId: string, name: string, messageId?: string): Promise<string> {
    if (!this.client) {
      throw new Error("Discord client is not connected");
    }

    // First, get channel info to determine its type
    const channelInfo = (await this.client.rest.get(Routes.channel(channelId))) as {
      type?: ChannelType;
      id?: string;
    };

    const channelType = channelInfo.type;

    // Handle forum channel (type 15) - create a new forum post
    if (channelType === ChannelType.GuildForum) {
      const forumPost = (await this.client.rest.post(Routes.channelMessages(channelId), {
        body: {
          name: name.slice(0, 100),
          content: " ", // Forum posts require at least some content
        },
      })) as { id?: string };
      return forumPost.id ?? channelId;
    }

    // Handle creating a thread from a message (GUILD_TEXT = 0)
    // Note: Discord API requires a message to create a thread from
    if (messageId) {
      const thread = (await this.client.rest.post(Routes.channel(channelId), {
        body: {
          name: name.slice(0, 100),
          type: ChannelType.PrivateThread, // 12 = PrivateThread
          message_id: messageId,
        },
      })) as { id?: string };
      return thread.id ?? channelId;
    }

    // Fallback: create a new thread without a message (public thread)
    // This requires the channel to have "default thread rate limit" set
    const thread = (await this.client.rest.post(Routes.channel(channelId), {
      body: {
        name: name.slice(0, 100),
        type: ChannelType.PublicThread, // 11 = PublicThread
      },
    })) as { id?: string };
    return thread.id ?? channelId;
  }

  /**
   * Diagnose Discord permission errors and provide actionable error messages.
   * @param error The error caught from Discord API
   * @param context Additional context about the operation being performed
   * @returns A diagnostic error with helpful guidance
   */
  static diagnosePermissionError(error: unknown, context?: string): Error {
    const err = error instanceof Error ? error : new Error(String(error));
    const errMsg = err.message.toLowerCase();

    // Common Discord permission error codes
    if (
      errMsg.includes("50013") ||
      errMsg.includes("missing permissions") ||
      errMsg.includes("permissions")
    ) {
      // Missing Permissions (50013)
      const baseMsg = context
        ? `Discord permission error during ${context}: Missing permissions.`
        : "Discord permission error: Missing permissions.";
      const diagnostic = new Error(
        `${baseMsg} ` +
          "The bot lacks required permissions. " +
          "Ensure the bot has: " +
          "1) 'Send Messages' permission in the channel, " +
          "2) 'Create Public/Private Threads' for thread operations, " +
          "3) 'Manage Threads' for forum posts. " +
          `Original error: ${err.message}`,
      );
      diagnostic.name = "DiscordPermissionError";
      return diagnostic;
    }

    if (
      errMsg.includes("50001") ||
      errMsg.includes("access denied") ||
      errMsg.includes("missing access")
    ) {
      // Missing Access (50001)
      const baseMsg = context
        ? `Discord access error during ${context}: Missing access.`
        : "Discord access error: Missing access.";
      const diagnostic = new Error(
        `${baseMsg} ` +
          "The bot cannot access this channel or message. " +
          "Possible causes: " +
          "1) Bot is not in the server, " +
          "2) Channel was deleted or bot was removed, " +
          "3) Bot role is below channel permissions. " +
          `Original error: ${err.message}`,
      );
      diagnostic.name = "DiscordAccessError";
      return diagnostic;
    }

    if (errMsg.includes("30033") || errMsg.includes("thread quota")) {
      // Thread quota exceeded (30033)
      const diagnostic = new Error(
        `Discord thread limit error: ${context ? `During ${context}, ` : ""}` +
          "Thread creation quota exceeded for this channel. " +
          "The channel has reached its maximum number of active threads. " +
          "Consider cleaning up old threads or using forum posts instead. " +
          `Original error: ${err.message}`,
      );
      diagnostic.name = "DiscordThreadQuotaError";
      return diagnostic;
    }

    if (errMsg.includes("40004") || errMsg.includes("unknown channel")) {
      // Unknown Channel (40004)
      const diagnostic = new Error(
        `Discord channel error: ${context ? `During ${context}, ` : ""}` +
          "The specified channel does not exist or is not accessible. " +
          "Verify the channel ID is correct and the bot has access. " +
          `Original error: ${err.message}`,
      );
      diagnostic.name = "DiscordChannelError";
      return diagnostic;
    }

    // Return original error if not a known Discord permission error
    return err;
  }

  private async sendViaWebhook(
    webhookUrl: string,
    chunks: string[],
    message: OutboundMessage,
  ): Promise<string> {
    const target = webhookUrl.trim();
    if (!target) {
      throw new Error("Discord webhookUrl is empty");
    }

    const flags = message.silent ? DISCORD_SUPPRESS_NOTIFICATIONS_FLAG : undefined;
    let lastId = "unknown";

    for (const [index, chunk] of chunks.entries()) {
      const isFirst = index === 0;
      const body: Record<string, unknown> = {};
      if (chunk.trim()) {
        body.content = chunk;
      }
      if (flags !== undefined) {
        body.flags = flags;
      }
      if (isFirst && message.buttons && message.buttons.length > 0) {
        body.components = message.buttons.slice(0, 5).map((row) => ({
          type: ComponentType.ActionRow,
          components: row.slice(0, 5).map((btn) => {
            if (btn.url) {
              return {
                type: ComponentType.Button,
                style: ButtonStyle.Link,
                label: btn.text.slice(0, 80),
                url: btn.url,
              };
            }
            return {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              label: btn.text.slice(0, 80),
              custom_id: (btn.callbackData ?? btn.text).slice(0, 100),
            };
          }),
        }));
      }
      if (isFirst && message.poll) {
        body.poll = {
          question: { text: message.poll.question.slice(0, 300) },
          answers: message.poll.options.slice(0, 10).map((option) => ({
            poll_media: { text: option.slice(0, 55) },
          })),
          allow_multiselect: message.poll.allowMultiselect ?? false,
          duration: Math.min(Math.max(message.poll.durationHours ?? 24, 1), 168),
        };
      }

      const response = await fetch(`${target}${target.includes("?") ? "&" : "?"}wait=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Discord webhook send failed: ${response.status}`);
      }

      const payload = (await response.json()) as { id?: string };
      if (payload.id) {
        lastId = payload.id;
      }
    }

    return lastId;
  }

  async editMessage(channelId: string, messageId: string, newText: string): Promise<void> {
    if (!this.client) {
      logger.warn({ channelId, messageId }, "Discord editMessage: client not connected");
      return;
    }

    try {
      await this.client.rest.patch(Routes.channelMessage(channelId, messageId), {
        body: serializePayload({ content: newText }),
      });
    } catch (error) {
      logger.warn({ error, channelId, messageId }, "Failed to edit Discord message");
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    if (!this.client) {
      logger.warn({ channelId, messageId }, "Discord deleteMessage: client not connected");
      return;
    }

    try {
      await this.client.rest.delete(Routes.channelMessage(channelId, messageId));
    } catch (error) {
      logger.warn({ error, channelId, messageId }, "Failed to delete Discord message");
    }
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

  /**
   * Intercept component interactions (button clicks) whose custom_id starts with "/"
   * and route them as InboundMessages through the command system.
   */
  private installButtonInteractionInterceptor(client: Client): void {
    if (typeof client.handleInteraction !== "function") {
      return;
    }
    const originalHandle = client.handleInteraction.bind(client);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const plugin = this;

    client.handleInteraction = async function (interaction: unknown, ctx: unknown) {
      const data = interaction as {
        type?: number;
        data?: { component_type?: number; custom_id?: string };
        id?: string;
        token?: string;
        channel_id?: string;
        guild_id?: string;
        member?: { user?: { id?: string; username?: string } };
        user?: { id?: string; username?: string };
      };

      // Only intercept MessageComponent interactions with command-like custom_ids
      if (data.type === InteractionType.MessageComponent && data.data?.custom_id?.startsWith("/")) {
        const customId = data.data.custom_id;
        const user = data.member?.user ?? data.user;

        // Acknowledge the interaction (type 6 = DEFERRED_UPDATE_MESSAGE)
        try {
          await client.rest.post(Routes.interactionCallback(data.id!, data.token!), {
            body: { type: 6 },
          });
        } catch (err) {
          logger.warn({ err }, "Failed to acknowledge Discord button interaction");
        }

        // Emit as InboundMessage
        const inbound: InboundMessage = {
          id: data.id ?? "unknown",
          channel: plugin.id,
          peerId: data.channel_id ?? "unknown",
          peerType: data.guild_id ? "group" : "dm",
          senderId: user?.id ?? "unknown",
          senderName: user?.username,
          text: customId,
          timestamp: new Date(),
          raw: data,
        };
        plugin.emitInboundMessage(inbound);
        return;
      }

      // Fall through to Carbon's default handling
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return originalHandle(interaction as any, ctx as any);
    };
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
      threadId: (msg.channel as unknown as { isThread?: () => boolean })?.isThread?.()
        ? msg.channelId
        : undefined,
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

async function resolveUrlMediaFile(
  item: MediaAttachment,
  index: number,
): Promise<MessagePayloadFile | undefined> {
  const mediaUrl = item.url;
  if (!mediaUrl) {
    return undefined;
  }

  try {
    const response = await fetch(mediaUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      logger.warn(
        { mediaUrl, status: response.status },
        "Discord URL media download failed, falling back to text URL",
      );
      return undefined;
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > DISCORD_MEDIA_URL_MAX_BYTES) {
      logger.warn(
        { mediaUrl, size: contentLength },
        "Discord URL media exceeds 50MB limit, falling back to text URL",
      );
      return undefined;
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > DISCORD_MEDIA_URL_MAX_BYTES) {
      logger.warn(
        { mediaUrl, size: arrayBuffer.byteLength },
        "Discord URL media exceeds 50MB limit after download, falling back to text URL",
      );
      return undefined;
    }

    const data = new Uint8Array(arrayBuffer);
    return {
      name: item.filename ?? `upload-url-${index + 1}`,
      data: toDiscordFileBlob(data, item.mimeType),
      description: undefined,
    };
  } catch (error) {
    logger.warn({ error, mediaUrl }, "Discord URL media download failed, falling back to text URL");
    return undefined;
  }
}

function resolveOutboundText(message: OutboundMessage, media: MediaAttachment[]): string {
  const text = message.text?.trim();
  if (text) {
    return text;
  }
  const caption = media.find((item) => item.caption?.trim())?.caption?.trim();
  return caption ?? "";
}

function toDiscordFileBlob(data: Buffer | Uint8Array, mimeType?: string): Blob {
  const arrayBuffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(arrayBuffer).set(data);
  return new Blob([arrayBuffer], mimeType ? { type: mimeType } : undefined);
}

async function resolveOutboundFiles(media: MediaAttachment[]): Promise<{
  files: MessagePayloadFile[];
  urls: string[];
}> {
  const files: MessagePayloadFile[] = [];
  const urls: string[] = [];

  for (const [index, item] of media.entries()) {
    if (item.buffer && item.buffer.byteLength > 0) {
      files.push({
        name: item.filename ?? `upload-${index + 1}`,
        data: toDiscordFileBlob(item.buffer, item.mimeType),
        description: undefined,
      });
      continue;
    }
    if (item.path) {
      const data = await fs.readFile(item.path);
      files.push({
        name: item.filename ?? path.basename(item.path),
        data: toDiscordFileBlob(data, item.mimeType),
        description: undefined,
      });
      continue;
    }
    if (item.url) {
      const downloaded = await resolveUrlMediaFile(item, index);
      if (downloaded) {
        files.push(downloaded);
      } else {
        urls.push(item.url);
      }
      continue;
    }
    logger.warn({ mediaIndex: index, mediaType: item.type }, "Discord attachment skipped");
  }

  return { files, urls };
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
