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
