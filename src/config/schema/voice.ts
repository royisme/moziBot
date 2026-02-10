import { z } from "zod";

export const WhisperCppSttConfigSchema = z
  .object({
    provider: z.literal("whisper.cpp"),
    binPath: z.string().min(1).optional(),
    modelPath: z.string().min(1),
    language: z.string().min(1).optional(),
    threads: z.number().int().positive().optional(),
    useCoreML: z.boolean().optional(),
    useMetal: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const RemoteSttProviderSchema = z.enum(["openai", "groq", "deepgram", "custom"]);

export const RemoteSttConfigSchema = z
  .object({
    provider: RemoteSttProviderSchema,
    endpoint: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const SttConfigSchema = z
  .object({
    strategy: z.enum(["local-only", "remote-only", "local-first"]).optional(),
    local: WhisperCppSttConfigSchema.optional(),
    remote: RemoteSttConfigSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.strategy === "local-only" && !value.local) {
      ctx.addIssue({
        code: "custom",
        path: ["local"],
        message: "local STT config is required when strategy is 'local-only'",
      });
    }

    if (value.strategy === "remote-only" && !value.remote) {
      ctx.addIssue({
        code: "custom",
        path: ["remote"],
        message: "remote STT config is required when strategy is 'remote-only'",
      });
    }

    if (value.strategy === "local-first" && !value.local) {
      ctx.addIssue({
        code: "custom",
        path: ["local"],
        message: "local STT config is required when strategy is 'local-first'",
      });
    }
  });

export const VoiceWakeConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    activationMode: z.enum(["click", "wake-word", "hybrid"]).optional(),
    keywords: z.array(z.string().min(1)).optional(),
    sensitivity: z.number().min(0).max(1).optional(),
  })
  .strict();

const UiPhaseVisualSchema = z
  .object({
    color: z.string().min(1).optional(),
    effect: z.enum(["idle", "pulse", "orbit", "glow", "wave"]).optional(),
    intensity: z.number().min(0).max(1).optional(),
  })
  .strict();

export const VoiceUiConfigSchema = z
  .object({
    phaseMapping: z
      .object({
        idle: UiPhaseVisualSchema.optional(),
        listening: UiPhaseVisualSchema.optional(),
        thinking: UiPhaseVisualSchema.optional(),
        speaking: UiPhaseVisualSchema.optional(),
        executing: UiPhaseVisualSchema.optional(),
        error: UiPhaseVisualSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const VoiceConfigSchema = z
  .object({
    stt: SttConfigSchema.optional(),
    wake: VoiceWakeConfigSchema.optional(),
    ui: VoiceUiConfigSchema.optional(),
  })
  .strict();

export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;
export type SttConfig = z.infer<typeof SttConfigSchema>;
export type WhisperCppSttConfig = z.infer<typeof WhisperCppSttConfigSchema>;
export type RemoteSttConfig = z.infer<typeof RemoteSttConfigSchema>;
export type VoiceWakeConfig = z.infer<typeof VoiceWakeConfigSchema>;
export type VoiceUiConfig = z.infer<typeof VoiceUiConfigSchema>;
