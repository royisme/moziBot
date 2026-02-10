import { describe, expect, it } from "vitest";
import type { MoziConfig } from "../config";
import { ModelRegistry } from "./model-registry";

function createConfig(): MoziConfig {
  return {
    models: {
      providers: {
        quotio: {
          api: "openai-responses",
          baseUrl: "https://example.invalid/v1",
          apiKey: "test-key",
          models: [{ id: "gemini-3-flash-preview" }, { id: "gemini-3-pro-preview" }],
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
});
