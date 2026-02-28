import { z } from "zod";

const AcpDispatchConfigSchema = z
  .object({
    /** Master switch for ACP turn dispatch in the reply pipeline. */
    enabled: z.boolean().optional(),
  })
  .strict();

const AcpStreamConfigSchema = z
  .object({
    /** Coalescer idle flush window in milliseconds for ACP streamed text. */
    coalesceIdleMs: z.number().int().positive().optional(),
    /** Maximum text size per streamed chunk. */
    maxChunkChars: z.number().int().positive().optional(),
  })
  .strict();

const AcpRuntimeConfigSchema = z
  .object({
    /** Idle runtime TTL in minutes for ACP session workers. */
    ttlMinutes: z.number().int().positive().optional(),
    /** Optional operator install/setup command shown by `/acp install` and `/acp doctor`. */
    installCommand: z.string().optional(),
  })
  .strict();

export const AcpConfigSchema = z
  .object({
    /** Global ACP runtime gate. */
    enabled: z.boolean().optional(),
    dispatch: AcpDispatchConfigSchema.optional(),
    /** Backend id registered by ACP runtime plugin (for example: acpx). */
    backend: z.string().optional(),
    defaultAgent: z.string().optional(),
    allowedAgents: z.array(z.string()).optional(),
    maxConcurrentSessions: z.number().int().positive().optional(),
    stream: AcpStreamConfigSchema.optional(),
    runtime: AcpRuntimeConfigSchema.optional(),
  })
  .strict();
