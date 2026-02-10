import { z } from "zod";

const IdListSchema = z
  .array(z.union([z.string(), z.number()]))
  .transform((items) => items.map((item) => item.toString()));

const DmScopeSchema = z.enum(["main", "per-peer", "per-channel-peer", "per-account-channel-peer"]);
const AccessPolicySchema = z.enum(["open", "allowlist"]);

const TelegramGroupConfigSchema = z
  .object({
    requireMention: z.boolean().optional(),
    allowFrom: IdListSchema.optional(),
    agentId: z.string().optional(),
    agent: z.string().optional(),
  })
  .strict();

const TelegramPollingConfigSchema = z
  .object({
    timeoutSeconds: z.number().int().positive().max(60).optional(),
    maxRetryTimeMs: z.number().int().positive().optional(),
    retryInterval: z.union([z.enum(["exponential", "quadratic"]), z.number().int().positive()]).optional(),
    silentRunnerErrors: z.boolean().optional(),
  })
  .strict();

const ChannelDmOverrideSchema = z
  .object({
    historyLimit: z.number().int().positive().optional(),
  })
  .strict();

export const TelegramConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    botToken: z.string().optional(),
    allowedChats: IdListSchema.optional(),
    dmScope: DmScopeSchema.optional(),
    dmPolicy: AccessPolicySchema.optional(),
    groupPolicy: AccessPolicySchema.optional(),
    allowFrom: IdListSchema.optional(),
    groups: z.record(z.string(), TelegramGroupConfigSchema).optional(),
    dmHistoryLimit: z.number().int().positive().optional(),
    dms: z.record(z.string(), ChannelDmOverrideSchema).optional(),
    streamMode: z.enum(["off", "partial", "full"]).optional(),
    polling: TelegramPollingConfigSchema.optional(),
    agentId: z.string().optional(),
    agent: z.string().optional(),
  })
  .strict();

export const DiscordConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    botToken: z.string().optional(),
    allowedGuilds: z.array(z.string()).optional(),
    allowedChannels: z.array(z.string()).optional(),
    dmHistoryLimit: z.number().int().positive().optional(),
    dms: z.record(z.string(), ChannelDmOverrideSchema).optional(),
    dmScope: DmScopeSchema.optional(),
    agentId: z.string().optional(),
    agent: z.string().optional(),
  })
  .strict();

export const LocalDesktopConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    host: z.string().min(1).optional(),
    port: z.number().int().positive().max(65535).optional(),
    authToken: z.string().min(1).optional(),
    allowOrigins: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const ChannelsSchema = z
  .object({
    dmScope: z
      .enum(["main", "per-peer", "per-channel-peer", "per-account-channel-peer"])
      .optional(),
    routing: z
      .object({
        dmAgentId: z.string().optional(),
        dmAgent: z.string().optional(),
        groupAgentId: z.string().optional(),
        groupAgent: z.string().optional(),
      })
      .optional(),
    telegram: TelegramConfigSchema.optional(),
    discord: DiscordConfigSchema.optional(),
    localDesktop: LocalDesktopConfigSchema.optional(),
  })
  .strict();
