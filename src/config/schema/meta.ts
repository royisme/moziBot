import { z } from "zod";

export const MetaSchema = z
  .object({
    version: z.string().optional(),
    createdAt: z.string().optional(),
  })
  .strict();
