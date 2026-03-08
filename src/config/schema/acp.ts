import { z } from "zod";

const AcpDispatchConfigSchema = z
  .object({
    /** Master switch for ACP turn dispatch in the reply pipeline. */
    enabled: z.boolean().default(false),
    /** TTL in milliseconds for message and conversation bindings. Default 24h. */
    messageBindingTtlMs: z.number().int().positive().optional(),
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
    ttlMinutes: z.number().int().nonnegative().default(0),
    /** Optional operator install/setup command shown by `/acp install` and `/acp doctor`. */
    installCommand: z.string().optional(),
  })
  .strict();

export const AcpConfigSchema = z
  .object({
    /** Global ACP runtime gate. */
    enabled: z.boolean().default(true),
    dispatch: AcpDispatchConfigSchema.optional(),
    /** @deprecated Use acp.dispatch.enabled */
    dispatchEnabled: z.boolean().optional(),
    /** Backend id registered by ACP runtime plugin (for example: acpx). */
    backend: z.string().optional(),
    defaultAgent: z.string().optional(),
    allowedAgents: z.array(z.string()).default([]),
    maxConcurrentSessions: z.number().int().positive().optional(),
    stream: AcpStreamConfigSchema.optional(),
    runtime: AcpRuntimeConfigSchema.default({ ttlMinutes: 0 }),
  })
  .strict()
  .superRefine((acp, ctx) => {
    const raw = acp as Record<string, unknown>;
    const legacyDispatchEnabled =
      typeof raw["dispatchEnabled"] === "boolean" ? raw["dispatchEnabled"] : undefined;
    if (
      typeof legacyDispatchEnabled === "boolean" &&
      typeof acp.dispatch?.enabled === "boolean" &&
      legacyDispatchEnabled !== acp.dispatch.enabled
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["dispatchEnabled"],
        message:
          "acp.dispatchEnabled conflicts with acp.dispatch.enabled. Keep only acp.dispatch.enabled.",
      });
    }
  })
  .transform((acp) => {
    const raw = acp as Record<string, unknown>;
    const legacyDispatchEnabled =
      typeof raw["dispatchEnabled"] === "boolean" ? raw["dispatchEnabled"] : undefined;
    const dispatchEnabled = acp.dispatch?.enabled ?? legacyDispatchEnabled ?? false;
    return {
      ...acp,
      dispatch: { ...acp.dispatch, enabled: dispatchEnabled },
    };
  });
