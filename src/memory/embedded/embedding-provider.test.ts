import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemoteEmbeddingProvider } from "./embedding-provider";

describe("createRemoteEmbeddingProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retries with truncated input when provider returns context-length error", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const requestBody = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(requestBody) as {
        input?: string[];
      };
      const first = body.input?.[0] ?? "";
      if (first.length > 300) {
        return {
          ok: false,
          status: 400,
          text: async () =>
            '{"error":{"message":"the input length exceeds the context length","type":"api_error"}}',
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: [{ embedding: [1, 2, 3] }],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createRemoteEmbeddingProvider({
      id: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.openai.com/v1",
        timeoutMs: 1_000,
        batchSize: 8,
      },
    });

    const result = await provider.embed(["x".repeat(1200)]);
    expect(result).toEqual([[1, 2, 3]]);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});
