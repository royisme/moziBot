import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStoreAdapter } from "../auth-profiles";
import type { ResolvedProvider } from "../types";
import { registerConfiguredPiProviders, resolvePiProviderRegistration } from "./pi-registration";

function createProvider(overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    id: "google",
    api: "google-generative-ai",
    auth: "api-key",
    baseUrl: "https://generativelanguage.googleapis.com",
    headers: { Authorization: "${GOOGLE_TOKEN}" },
    models: [{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" }],
    transportKind: "native-sdk",
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.GOOGLE_TOKEN;
});

describe("resolvePiProviderRegistration", () => {
  it("skips native-sdk providers", () => {
    expect(resolvePiProviderRegistration(createProvider())).toBeNull();
  });

  it("registers openai-compat providers with compatible models only", () => {
    const registration = resolvePiProviderRegistration(
      createProvider({
        id: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        transportKind: "openai-compat",
        models: [
          { id: "gpt-4o", name: "GPT-4o" },
          { id: "wrong", name: "Wrong", api: "anthropic-messages" },
        ],
      }),
    );

    expect(registration?.api).toBe("openai-responses");
    expect(registration?.models.map((model) => model.id)).toEqual(["gpt-4o"]);
  });
});

describe("registerConfiguredPiProviders", () => {
  it("registers only openai-compat providers and resolves secret-backed headers", () => {
    process.env.GOOGLE_TOKEN = "secret-token";
    const registry = { registerProvider: vi.fn() };

    registerConfiguredPiProviders({
      registry,
      providers: [
        createProvider(),
        createProvider({
          id: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          transportKind: "openai-compat",
          headers: { Authorization: "${GOOGLE_TOKEN}" },
          models: [{ id: "gpt-4o", name: "GPT-4o", input: ["text", "image", "file"] }],
        }),
      ],
      authProfiles: {
        resolveApiKey: vi.fn(() => undefined),
      } as unknown as AuthProfileStoreAdapter,
      createCodexDefaultTransportWrapper: vi.fn(() => "wrapped-stream" as never),
    });

    expect(registry.registerProvider).toHaveBeenCalledTimes(1);
    expect(registry.registerProvider).toHaveBeenCalledWith(
      "openai",
      expect.objectContaining({
        headers: { Authorization: "secret-token" },
        models: [
          expect.objectContaining({
            id: "gpt-4o",
            input: ["text", "image"],
          }),
        ],
      }),
    );
  });
});
