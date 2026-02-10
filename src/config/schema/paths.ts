import { z } from "zod";

export const PathsSchema = z
  .object({
    baseDir: z.string().optional(),
    sessions: z.string().optional(),
    logs: z.string().optional(),
    skills: z.string().optional(),
    workspace: z.string().optional(),
  })
  .strict();
