import { z } from "zod";

const DmScopeSchema = z.enum(["main", "per-peer", "per-channel-peer", "per-account-channel-peer"]);

const IdentityListSchema = z
  .array(z.union([z.string(), z.number()]))
  .transform((items) => items.map((item) => item.toString()));

const SessionResetModeSchema = z.enum(["daily", "idle", "disabled"]);

const SessionResetPolicySchema = z
  .object({
    mode: SessionResetModeSchema.optional(),
    atHour: z.number().int().min(0).max(23).optional(),
    idleMinutes: z.number().int().positive().optional(),
  })
  .strict();

const SessionResetByTypeSchema = z
  .object({
    direct: SessionResetPolicySchema.optional(),
    group: SessionResetPolicySchema.optional(),
    thread: SessionResetPolicySchema.optional(),
  })
  .strict();

export const SessionConfigSchema = z
  .object({
    dmScope: DmScopeSchema.optional(),
    mainKey: z.string().min(1).optional(),
    identityLinks: z.record(z.string(), IdentityListSchema).optional(),
    reset: SessionResetPolicySchema.optional(),
    resetByType: SessionResetByTypeSchema.optional(),
    resetByChannel: z.record(z.string(), SessionResetPolicySchema).optional(),
  })
  .strict();
