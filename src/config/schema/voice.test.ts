import { describe, expect, it } from "vitest";
import { MoziConfigSchema } from "./index";

describe("Voice schema", () => {
  it("accepts local-only whisper.cpp config", () => {
    const result = MoziConfigSchema.safeParse({
      voice: {
        stt: {
          strategy: "local-only",
          local: {
            provider: "whisper.cpp",
            binPath: "whisper-cli",
            modelPath: "~/Library/Application Support/alma/whisper_models/ggml-large-v3-turbo.bin",
            language: "zh",
            threads: 8,
            useMetal: true,
            timeoutMs: 10000,
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts local-first with remote fallback", () => {
    const result = MoziConfigSchema.safeParse({
      voice: {
        stt: {
          strategy: "local-first",
          local: {
            provider: "whisper.cpp",
            modelPath: "/models/ggml-large-v3-turbo.bin",
          },
          remote: {
            provider: "openai",
            model: "whisper-1",
            apiKey: "${STT_API_KEY}",
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects local-only without local config", () => {
    const result = MoziConfigSchema.safeParse({
      voice: {
        stt: {
          strategy: "local-only",
          remote: {
            provider: "openai",
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects unknown fields in local whisper.cpp config", () => {
    const result = MoziConfigSchema.safeParse({
      voice: {
        stt: {
          local: {
            provider: "whisper.cpp",
            modelPath: "/models/ggml-large-v3-turbo.bin",
            unknownField: true,
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts wake and UI phase mapping config", () => {
    const result = MoziConfigSchema.safeParse({
      voice: {
        wake: {
          enabled: true,
          activationMode: "hybrid",
          keywords: ["mozi", "墨子"],
          sensitivity: 0.7,
        },
        ui: {
          phaseMapping: {
            listening: {
              color: "#5BC0FF",
              effect: "wave",
              intensity: 0.8,
            },
            executing: {
              color: "#00FF7A",
              effect: "glow",
              intensity: 1,
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts edge-only tts config", () => {
    const result = MoziConfigSchema.safeParse({
      voice: {
        tts: {
          strategy: "fallback-chain",
          maxChars: 1500,
          providerOrder: ["edge"],
          edge: {
            enabled: true,
            voice: "en-US-AriaNeural",
            rate: "+0%",
            pitch: "+0Hz",
            format: "audio-24khz-48kbitrate-mono-mp3",
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts openai and elevenlabs fallback with required fields", () => {
    const result = MoziConfigSchema.safeParse({
      voice: {
        tts: {
          providerOrder: ["openai", "elevenlabs"],
          openai: {
            enabled: true,
            apiKey: "${OPENAI_API_KEY}",
            model: "gpt-4o-mini-tts",
            voice: "alloy",
            format: "mp3",
            timeoutMs: 20000,
          },
          elevenlabs: {
            enabled: true,
            apiKey: "${ELEVENLABS_API_KEY}",
            voiceId: "voice-123",
            modelId: "eleven_multilingual_v2",
            format: "mp3_22050_32",
            applyTextNormalization: "auto",
            languageCode: "en",
            voiceSettings: {
              stability: 0.5,
              similarityBoost: 0.75,
              style: 0.1,
              useSpeakerBoost: true,
              speed: 1,
            },
            timeoutMs: 20000,
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects empty tts providerOrder", () => {
    const result = MoziConfigSchema.safeParse({
      voice: {
        tts: {
          providerOrder: [],
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects openai provider without apiKey", () => {
    const result = MoziConfigSchema.safeParse({
      voice: {
        tts: {
          providerOrder: ["openai"],
          openai: {
            enabled: true,
            model: "gpt-4o-mini-tts",
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects elevenlabs provider without voiceId", () => {
    const result = MoziConfigSchema.safeParse({
      voice: {
        tts: {
          providerOrder: ["elevenlabs"],
          elevenlabs: {
            enabled: true,
            apiKey: "${ELEVENLABS_API_KEY}",
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects elevenlabs voiceSettings outside range", () => {
    const result = MoziConfigSchema.safeParse({
      voice: {
        tts: {
          providerOrder: ["elevenlabs"],
          elevenlabs: {
            enabled: true,
            apiKey: "${ELEVENLABS_API_KEY}",
            voiceId: "voice-123",
            voiceSettings: {
              stability: 1.2,
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts valid vad config", () => {
    const result = MoziConfigSchema.safeParse({
      voice: {
        vad: {
          enabled: true,
          startThreshold: 0.02,
          endThreshold: 0.012,
          silenceMs: 1500,
          minSpeechMs: 350,
          maxSpeechMs: 15000,
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects vad when startThreshold is lower than endThreshold", () => {
    const result = MoziConfigSchema.safeParse({
      voice: {
        vad: {
          startThreshold: 0.01,
          endThreshold: 0.02,
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects vad when minSpeechMs is greater than maxSpeechMs", () => {
    const result = MoziConfigSchema.safeParse({
      voice: {
        vad: {
          minSpeechMs: 16000,
          maxSpeechMs: 15000,
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects wake sensitivity out of range", () => {
    const result = MoziConfigSchema.safeParse({
      voice: {
        wake: {
          sensitivity: 1.2,
        },
      },
    });

    expect(result.success).toBe(false);
  });
});
