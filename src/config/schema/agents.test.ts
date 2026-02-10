import { describe, expect, it } from "vitest";
import { MoziConfigSchema } from "./index";

describe("Agents schema", () => {
  it("accepts a single explicit main agent", () => {
    const result = MoziConfigSchema.safeParse({
      agents: {
        alpha: { main: true },
        beta: {},
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects multiple main agents", () => {
    const result = MoziConfigSchema.safeParse({
      agents: {
        alpha: { main: true },
        beta: { main: true },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const messages = result.error.issues.map((issue) => issue.message);
    expect(messages).toContain("Only one agent can set main=true.");
  });

  it("allows no explicit main agent", () => {
    const result = MoziConfigSchema.safeParse({
      agents: {
        alpha: {},
        beta: {},
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts modality-specific model routing fields", () => {
    const result = MoziConfigSchema.safeParse({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4o",
            vision: "openai/gpt-4o-vision",
            visionFallbacks: ["openai/gpt-4o-mini-vision"],
            audio: "openai/gpt-4o-audio",
            audioFallbacks: ["openai/gpt-4o-mini-audio"],
            video: "openai/gpt-4o-video",
            videoFallbacks: ["openai/gpt-4o-mini-video"],
            file: "openai/gpt-4o-file",
            fileFallbacks: ["openai/gpt-4o-mini-file"],
          },
        },
        mozi: { main: true },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts context pruning and context tokens fields", () => {
    const result = MoziConfigSchema.safeParse({
      agents: {
        defaults: {
          contextTokens: 128000,
          contextPruning: {
            enabled: true,
            softTrimRatio: 0.5,
            hardClearRatio: 0.7,
            keepLastAssistants: 3,
            minPrunableChars: 20000,
            softTrim: {
              maxChars: 4000,
              headChars: 1500,
              tailChars: 1500,
            },
            protectedTools: ["read_file"],
          },
        },
        mozi: {
          contextPruning: {
            enabled: false,
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts exec allowedSecrets policy", () => {
    const result = MoziConfigSchema.safeParse({
      agents: {
        defaults: {
          exec: {
            allowlist: ["node", "pnpm"],
            allowedSecrets: ["OPENAI_API_KEY", "TAVILY_API_KEY"],
          },
        },
        mozi: {
          main: true,
          exec: {
            allowedSecrets: ["OPENAI_API_KEY"],
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts lifecycle control/temporal/semantic config on defaults and agent overrides", () => {
    const result = MoziConfigSchema.safeParse({
      agents: {
        defaults: {
          lifecycle: {
            control: {
              model: "quotio/gemini-3-flash-preview",
              fallback: ["openai/gpt-4o-mini"],
            },
            temporal: {
              enabled: true,
              activeWindowHours: 12,
              dayBoundaryRollover: true,
            },
            semantic: {
              enabled: true,
              threshold: 0.8,
              debounceSeconds: 60,
              reversible: true,
            },
          },
        },
        mozi: {
          lifecycle: {
            control: {
              model: "openai/gpt-4o-mini",
            },
            semantic: {
              threshold: 0.9,
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects lifecycle semantic threshold outside [0,1]", () => {
    const result = MoziConfigSchema.safeParse({
      agents: {
        defaults: {
          lifecycle: {
            semantic: {
              threshold: 1.5,
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });
});
