import { describe, expect, it } from "vitest";
import type { MoziConfig } from "../../config";
import { composeResolvedProvider } from "./composition";

describe("composeResolvedProvider", () => {
  it("defaults google to native-sdk transport and canonical baseUrl/api", () => {
    const config: MoziConfig = {
      models: {
        providers: {
          google: {
            apiKey: "test-key",
            models: [{ id: "gemini-2.5-flash", name: "gemini-2.5-flash" }],
          },
        },
      },
    };

    const googleProvider = config.models?.providers?.google;
    expect(googleProvider).toBeDefined();
    if (!googleProvider) {
      throw new Error("Expected google provider config");
    }

    const provider = composeResolvedProvider("google", googleProvider);
    expect(provider.transportKind).toBe("native-sdk");
    expect(provider.api).toBe("google-generative-ai");
    expect(provider.baseUrl).toBe("https://generativelanguage.googleapis.com");
  });

  it("preserves explicit transportKind override", () => {
    const provider = composeResolvedProvider("google", {
      transportKind: "openai-compat",
      baseUrl: "https://example.invalid/google",
      models: [{ id: "gemini-2.5-flash", name: "gemini-2.5-flash" }],
    } as never);

    expect(provider.transportKind).toBe("openai-compat");
    expect(provider.baseUrl).toBe("https://example.invalid/google");
  });

  it("merges static catalog metadata into configured model overrides", () => {
    const provider = composeResolvedProvider("google", {
      apiKey: "test-key",
      models: [{ id: "gemini-2.5-flash", name: "gemini-2.5-flash", maxTokens: 1234 }],
    });

    const model = provider.models?.find((entry) => entry.id === "gemini-2.5-flash");
    expect(model?.input).toEqual(["text", "image"]);
    expect(model?.maxTokens).toBe(1234);
  });
});
