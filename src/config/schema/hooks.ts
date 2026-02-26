import { z } from "zod";

const SessionMemoryHookSchema = z
  .object({
    enabled: z.boolean().optional(),
    messages: z.number().int().positive().optional(),
    llmSlug: z.boolean().optional(),
    model: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const HooksConfigSchema = z
  .object({
    sessionMemory: SessionMemoryHookSchema.optional(),
  })
  .strict();

export type HooksConfig = z.infer<typeof HooksConfigSchema>;
