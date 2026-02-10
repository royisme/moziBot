import { z } from "zod";

export const RuntimeQueueConfigSchema = z
  .object({
    mode: z.enum(["followup", "collect", "interrupt", "steer", "steer-backlog"]).optional(),
    collectWindowMs: z.number().int().nonnegative().optional(),
    maxBacklog: z.number().int().positive().optional(),
  })
  .strict();

const RuntimeCronScheduleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("at"),
      atMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("every"),
      everyMs: z.number().int().positive(),
      anchorMs: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cron"),
      expr: z.string().min(1),
      tz: z.string().min(1).optional(),
    })
    .strict(),
]);

const RuntimeCronPayloadSchema = z
  .object({
    kind: z.enum(["systemEvent", "agentTurn", "sendMessage"]),
    text: z.string().optional(),
    sessionKey: z.string().optional(),
    agentId: z.string().optional(),
    channel: z.string().optional(),
    target: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();

const RuntimeCronJobSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    schedule: RuntimeCronScheduleSchema,
    payload: RuntimeCronPayloadSchema,
    enabled: z.boolean().optional(),
  })
  .strict();

export const RuntimeCronConfigSchema = z
  .object({
    jobs: z.array(RuntimeCronJobSchema).optional(),
  })
  .strict();

const RuntimeAuthConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    store: z.enum(["sqlite"]).optional(),
    masterKeyEnv: z.string().min(1).optional(),
    defaultScope: z.enum(["global", "agent"]).optional(),
  })
  .strict();

export const RuntimeConfigSchema = z
  .object({
    sanitizeToolSchema: z.boolean().optional(),
    queue: RuntimeQueueConfigSchema.optional(),
    cron: RuntimeCronConfigSchema.optional(),
    auth: RuntimeAuthConfigSchema.optional(),
  })
  .strict();

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
