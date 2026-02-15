import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAiTts } from "./openai";

describe("openAiTts", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns audio result for successful response", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(Buffer.from("openai-audio"), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await openAiTts("hello", {
      apiKey: "test-key",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      format: "mp3",
      timeoutMs: 5000,
    });

    expect(result.provider).toBe("openai");
    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.buffer.byteLength).toBeGreaterThan(0);
  });

  it("throws when api key is missing", async () => {
    await expect(openAiTts("hello", undefined)).rejects.toThrow("apiKey is missing");
  });
});
