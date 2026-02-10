import { z } from "zod";

export const LoggingSchema = z
  .object({
    level: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).optional(),
  })
  .strict();
