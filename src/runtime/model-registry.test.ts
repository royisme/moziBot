import { describe, expect, it } from "vitest";
import type { MoziConfig } from "../config";
import { ModelRegistry } from "./model-registry";
import { ProviderRegistry } from "./provider-registry";
import { findProvidersByEnvVar } from "./providers/contracts";

function createConfig(): MoziConfig {
  return {
    models: {
      providers: {
        quotio: {
          api: "openai-responses",
          baseUrl: "https://example.invalid/v1",
          apiKey: "test-key",
          models: [
            { id: "gemini-3-flash-preview", name: "gemini-3-flash-preview" },
            { id: "gemini-3-pro-preview", name: "gemini-3-pro-preview" },
          ],
        },
      },
    },
    agents: {
      mozi: {
        model: "quotio/gemini-3-flash-preview",
      },
    },
  };
}

describe("ModelRegistry", () => {
  it("resolves exact model reference", () => {
    const registry = new ModelRegistry(createConfig());
    const resolved = registry.resolve("quotio/gemini-3-flash-preview");
    expect(resolved?.ref).toBe("quotio/gemini-3-flash-preview");
  });

  it("falls back to provider api when model api is omitted", () => {
    const registry = new ModelRegistry(createConfig());
    const spec = registry.get("quotio/gemini-3-flash-preview");
    expect(spec?.api).toBe("openai-responses");
  });

  it("falls back to provider contract default api when provider api is omitted", () => {
    const registry = new ModelRegistry({
      models: {
        providers: {
          google: {
            apiKey: "test-key",
            models: [{ id: "gemini-2.5-flash", name: "gemini-2.5-flash" }],
          },
        },
      },
    });
    const spec = registry.get("google/gemini-2.5-flash");
    expect(spec?.api).toBe("google-generative-ai");
  });

  it("omits canonical google baseUrl from provider composition when omitted in config (native SDK)", () => {
    const providers = new ProviderRegistry({
      models: {
        providers: {
          google: {
            apiKey: "test-key",
            models: [{ id: "gemini-2.5-flash", name: "gemini-2.5-flash" }],
          },
        },
      },
    });
    expect(providers.get("google")?.baseUrl).toBeUndefined();
    expect(providers.get("google")?.transportKind).toBe("native-sdk");
  });

  it("classifies Gemini CLI providers as cli-backend transport", () => {
    const providers = new ProviderRegistry({
      models: {
        providers: {
          "google-gemini-cli": {
            api: "cli-backend",
            models: [{ id: "gemini-2.5-flash", name: "gemini-2.5-flash" }],
          },
        },
      },
    });
    expect(providers.get("google-gemini-cli")?.transportKind).toBe("cli-backend");
  });

  it("keeps baseUrl undefined even when configure persists no baseUrl override (native SDK)", () => {
    const providers = new ProviderRegistry({
      models: {
        providers: {
          google: {
            apiKey: "${GEMINI_API_KEY}",
          },
        },
      },
    });
    expect(providers.get("google")?.baseUrl).toBeUndefined();
  });

  it("preserves configured non-default google baseUrl override", () => {
    const providers = new ProviderRegistry({
      models: {
        providers: {
          google: {
            apiKey: "test-key",
            baseUrl: "https://example.invalid/google",
            models: [{ id: "gemini-2.5-flash", name: "gemini-2.5-flash" }],
          },
        },
      },
    });
    expect(providers.get("google")?.baseUrl).toBe("https://example.invalid/google");
  });

  it("merges built-in provider catalog metadata into configured model overrides", () => {
    const providers = new ProviderRegistry({
      models: {
        providers: {
          google: {
            apiKey: "test-key",
            models: [{ id: "gemini-2.5-flash", name: "gemini-2.5-flash", maxTokens: 1234 }],
          },
        },
      },
    });
    const model = providers.get("google")?.models?.find((entry) => entry.id === "gemini-2.5-flash");
    expect(model?.input).toEqual(["text", "image"]);
    expect(model?.maxTokens).toBe(1234);
  });

  it("derives provider env links from shared provider contracts", () => {
    expect(findProvidersByEnvVar("OPENAI_API_KEY")).toEqual(["openai"]);
    expect(findProvidersByEnvVar("GEMINI_API_KEY")).toEqual(["google"]);
    expect(findProvidersByEnvVar("DOES_NOT_EXIST")).toEqual([]);
  });

  it("resolves typo to closest model in same provider", () => {
    const registry = new ModelRegistry(createConfig());
    const resolved = registry.resolve("quotio/gemini-3-flash-perview");
    expect(resolved?.ref).toBe("quotio/gemini-3-flash-preview");
  });

  it("suggests model refs when lookup fails", () => {
    const registry = new ModelRegistry(createConfig());
    const suggestions = registry.suggestRefs("quotio/unknown-model", 2);
    expect(suggestions).toContain("quotio/gemini-3-flash-preview");
    expect(suggestions.length).toBe(2);
  });

  it("resolves alias refs to canonical models", () => {
    const config = createConfig();
    const registry = new ModelRegistry({
      ...config,
      models: {
        ...config.models,
        aliases: { flash: "quotio/gemini-3-flash-preview" },
      },
    });
    const resolved = registry.resolve("flash");
    expect(resolved?.ref).toBe("quotio/gemini-3-flash-preview");
    expect(resolved?.spec.id).toBe("gemini-3-flash-preview");
  });

  it("looks up aliases case-insensitively via get", () => {
    const config = createConfig();
    const registry = new ModelRegistry({
      ...config,
      models: {
        ...config.models,
        aliases: { flash: "quotio/gemini-3-flash-preview" },
      },
    });
    const spec = registry.get("FLASH");
    expect(spec?.id).toBe("gemini-3-flash-preview");
  });

  it("keeps canonical model in alias suggestion results", () => {
    const config = createConfig();
    const registry = new ModelRegistry({
      ...config,
      models: {
        ...config.models,
        aliases: { flash: "quotio/gemini-3-flash-preview" },
      },
    });
    const suggestions = registry.suggestRefs("flsh", 3);
    expect(suggestions[0]).toBe("quotio/gemini-3-flash-preview");
    expect(suggestions).toContain("quotio/gemini-3-flash-preview");
  });
});
