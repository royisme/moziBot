import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { elevenLabsTts } from "./elevenlabs";

describe("elevenLabsTts", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns audio result for successful response", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.apply_text_normalization).toBe("auto");
      expect(body.language_code).toBe("en");
      expect(body.voice_settings.similarity_boost).toBe(0.9);

      return new Response(Buffer.from("eleven-audio"), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await elevenLabsTts("hello", {
      apiKey: "test-key",
      voiceId: "voice-123",
      modelId: "eleven_multilingual_v2",
      format: "mp3_22050_32",
      applyTextNormalization: "auto",
      languageCode: "en",
      voiceSettings: {
        similarityBoost: 0.9,
      },
      timeoutMs: 5000,
    });

    expect(result.provider).toBe("elevenlabs");
    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.buffer.byteLength).toBeGreaterThan(0);
  });

  it("throws when api key is missing", async () => {
    await expect(elevenLabsTts("hello", undefined)).rejects.toThrow("apiKey is missing");
  });
});
