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

export const TtsProviderSchema = z.enum(["edge", "openai", "elevenlabs"]);

export const EdgeTtsConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    voice: z.string().min(1).optional(),
    rate: z.string().min(1).optional(),
    pitch: z.string().min(1).optional(),
    format: z.enum(["audio-24khz-48kbitrate-mono-mp3", "riff-24khz-16bit-mono-pcm"]).optional(),
  })
  .strict();

export const OpenAiTtsConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    apiKey: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    voice: z.string().min(1).optional(),
    format: z.enum(["mp3", "wav"]).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const ElevenLabsTtsConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    apiKey: z.string().min(1).optional(),
    voiceId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    format: z.enum(["mp3_22050_32", "pcm_16000"]).optional(),
    applyTextNormalization: z.enum(["auto", "on", "off"]).optional(),
    languageCode: z.string().min(1).optional(),
    voiceSettings: z
      .object({
        stability: z.number().min(0).max(1).optional(),
        similarityBoost: z.number().min(0).max(1).optional(),
        style: z.number().min(0).max(1).optional(),
        useSpeakerBoost: z.boolean().optional(),
        speed: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const TtsConfigSchema = z
  .object({
    strategy: z.enum(["provider-only", "fallback-chain"]).optional(),
    maxChars: z.number().int().min(50).max(10000).optional(),
    providerOrder: z.array(TtsProviderSchema).optional(),
    edge: EdgeTtsConfigSchema.optional(),
    openai: OpenAiTtsConfigSchema.optional(),
    elevenlabs: ElevenLabsTtsConfigSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const providerOrder = value.providerOrder ?? [];
    if (value.providerOrder && providerOrder.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["providerOrder"],
        message: "providerOrder cannot be empty when tts config is present",
      });
    }

    if (providerOrder.includes("edge") && value.edge?.enabled === false) {
      ctx.addIssue({
        code: "custom",
        path: ["edge", "enabled"],
        message: "edge provider cannot be disabled when included in providerOrder",
      });
    }

    if (providerOrder.includes("openai")) {
      if (!value.openai) {
        ctx.addIssue({
          code: "custom",
          path: ["openai"],
          message: "openai config is required when openai is in providerOrder",
        });
      } else {
        if (value.openai.enabled === false) {
          ctx.addIssue({
            code: "custom",
            path: ["openai", "enabled"],
            message: "openai provider cannot be disabled when included in providerOrder",
          });
        }
        if (!value.openai.apiKey) {
          ctx.addIssue({
            code: "custom",
            path: ["openai", "apiKey"],
            message: "openai apiKey is required when openai is in providerOrder",
          });
        }
      }
    }

    if (providerOrder.includes("elevenlabs")) {
      if (!value.elevenlabs) {
        ctx.addIssue({
          code: "custom",
          path: ["elevenlabs"],
          message: "elevenlabs config is required when elevenlabs is in providerOrder",
        });
      } else {
        if (value.elevenlabs.enabled === false) {
          ctx.addIssue({
            code: "custom",
            path: ["elevenlabs", "enabled"],
            message: "elevenlabs provider cannot be disabled when included in providerOrder",
          });
        }
        if (!value.elevenlabs.apiKey) {
          ctx.addIssue({
            code: "custom",
            path: ["elevenlabs", "apiKey"],
            message: "elevenlabs apiKey is required when elevenlabs is in providerOrder",
          });
        }
        if (!value.elevenlabs.voiceId) {
          ctx.addIssue({
            code: "custom",
            path: ["elevenlabs", "voiceId"],
            message: "elevenlabs voiceId is required when elevenlabs is in providerOrder",
          });
        }
      }
    }
  });

export const VoiceVadConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    startThreshold: z.number().min(0).max(1).optional(),
    endThreshold: z.number().min(0).max(1).optional(),
    silenceMs: z.number().int().positive().optional(),
    minSpeechMs: z.number().int().positive().optional(),
    maxSpeechMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      typeof value.startThreshold === "number" &&
      typeof value.endThreshold === "number" &&
      value.startThreshold < value.endThreshold
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["startThreshold"],
        message: "startThreshold must be greater than or equal to endThreshold",
      });
    }
    if (
      typeof value.minSpeechMs === "number" &&
      typeof value.maxSpeechMs === "number" &&
      value.minSpeechMs > value.maxSpeechMs
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["minSpeechMs"],
        message: "minSpeechMs must be less than or equal to maxSpeechMs",
      });
    }
  });

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
    tts: TtsConfigSchema.optional(),
    vad: VoiceVadConfigSchema.optional(),
    wake: VoiceWakeConfigSchema.optional(),
    ui: VoiceUiConfigSchema.optional(),
  })
  .strict();

export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;
export type SttConfig = z.infer<typeof SttConfigSchema>;
export type WhisperCppSttConfig = z.infer<typeof WhisperCppSttConfigSchema>;
export type RemoteSttConfig = z.infer<typeof RemoteSttConfigSchema>;
export type TtsConfig = z.infer<typeof TtsConfigSchema>;
export type VoiceVadConfig = z.infer<typeof VoiceVadConfigSchema>;
export type EdgeTtsConfig = z.infer<typeof EdgeTtsConfigSchema>;
export type OpenAiTtsConfig = z.infer<typeof OpenAiTtsConfigSchema>;
export type ElevenLabsTtsConfig = z.infer<typeof ElevenLabsTtsConfigSchema>;
export type VoiceWakeConfig = z.infer<typeof VoiceWakeConfigSchema>;
export type VoiceUiConfig = z.infer<typeof VoiceUiConfigSchema>;
