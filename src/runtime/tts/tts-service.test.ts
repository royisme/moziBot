import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MoziConfig } from "../../config";
import { TtsService } from "./tts-service";

const mocks = vi.hoisted(() => ({
  edgeTtsMock: vi.fn(),
  openAiTtsMock: vi.fn(),
  elevenLabsTtsMock: vi.fn(),
}));

vi.mock("./providers/edge", () => ({
  edgeTts: mocks.edgeTtsMock,
}));

vi.mock("./providers/openai", () => ({
  openAiTts: mocks.openAiTtsMock,
}));

vi.mock("./providers/elevenlabs", () => ({
  elevenLabsTts: mocks.elevenLabsTtsMock,
}));

function createConfig(overrides?: Partial<MoziConfig>): MoziConfig {
  return {
    voice: {
      tts: {
        maxChars: 1500,
        providerOrder: ["edge"],
        edge: {
          enabled: true,
          voice: "en-US-AriaNeural",
          format: "audio-24khz-48kbitrate-mono-mp3",
        },
      },
    },
    ...overrides,
  };
}

describe("TtsService", () => {
  beforeEach(() => {
    mocks.edgeTtsMock.mockReset();
    mocks.openAiTtsMock.mockReset();
    mocks.elevenLabsTtsMock.mockReset();
  });

  it("uses edge provider by default", async () => {
    mocks.edgeTtsMock.mockResolvedValue({
      provider: "edge",
      mimeType: "audio/mpeg",
      buffer: Buffer.from("audio"),
      voice: "en-US-AriaNeural",
    });

    const service = new TtsService(createConfig());
    const result = await service.textToSpeech("hello world");

    expect(result.provider).toBe("edge");
    expect(mocks.edgeTtsMock).toHaveBeenCalledWith(
      "hello world",
      expect.objectContaining({ voice: "en-US-AriaNeural" }),
    );
  });

  it("falls back to openai when edge fails", async () => {
    mocks.edgeTtsMock.mockRejectedValue(new Error("edge failed"));
    mocks.openAiTtsMock.mockResolvedValue({
      provider: "openai",
      mimeType: "audio/mpeg",
      buffer: Buffer.from("audio-openai"),
      voice: "alloy",
    });

    const service = new TtsService(
      createConfig({
        voice: {
          tts: {
            providerOrder: ["edge", "openai"],
            edge: { enabled: true },
            openai: { enabled: true, apiKey: "test-key", model: "gpt-4o-mini-tts" },
          },
        },
      }),
    );

    const result = await service.textToSpeech("fallback please");
    expect(result.provider).toBe("openai");
    expect(mocks.edgeTtsMock).toHaveBeenCalledTimes(1);
    expect(mocks.openAiTtsMock).toHaveBeenCalledTimes(1);
  });

  it("truncates text according to maxChars", async () => {
    mocks.edgeTtsMock.mockResolvedValue({
      provider: "edge",
      mimeType: "audio/mpeg",
      buffer: Buffer.from("audio"),
    });

    const service = new TtsService(
      createConfig({
        voice: {
          tts: {
            maxChars: 5,
            providerOrder: ["edge"],
            edge: { enabled: true },
          },
        },
      }),
    );

    await service.textToSpeech("123456789");
    expect(mocks.edgeTtsMock).toHaveBeenCalledWith("12345", expect.anything());
  });

  it("throws aggregate error when all providers fail", async () => {
    mocks.edgeTtsMock.mockRejectedValue(new Error("edge failed"));
    mocks.openAiTtsMock.mockRejectedValue(new Error("openai failed"));

    const service = new TtsService(
      createConfig({
        voice: {
          tts: {
            providerOrder: ["edge", "openai"],
            edge: { enabled: true },
            openai: { enabled: true, apiKey: "test-key" },
          },
        },
      }),
    );

    await expect(service.textToSpeech("hello")).rejects.toThrow("All TTS providers failed");
  });
});
