import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretManager, WizardContext, WizardUI } from "../types";
import { providerSection } from "./provider";

function createUi(
  overrides?: Partial<WizardUI>,
): WizardUI & { __mocks: { note: ReturnType<typeof vi.fn> } } {
  const note = vi.fn();
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    text: vi.fn(async () => ""),
    confirm: vi.fn(async () => true),
    select: vi.fn(async ({ options }) => options[0]?.value),
    multiselect: vi.fn(async () => []),
    password: vi.fn(async () => "secret-value"),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
    note,
    warn: vi.fn(),
    error: vi.fn(),
    __mocks: { note },
    ...overrides,
  };
}

function createSecrets(): SecretManager & { __mocks: { set: ReturnType<typeof vi.fn> } } {
  const values = new Map<string, string>();
  const set = vi.fn(async (key: string, value: string) => {
    values.set(key, value);
  });
  return {
    get: vi.fn(async (key: string) => values.get(key)),
    getEffective: vi.fn(async (key: string) => values.get(key)),
    set,
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    list: vi.fn(async () => Array.from(values.keys())),
    has: vi.fn(async (key: string) => values.has(key)),
    __mocks: { set },
  };
}

function createContext(params?: {
  nonInteractive?: boolean;
  ui?: WizardUI;
  secrets?: SecretManager;
}): WizardContext {
  return {
    config: {
      paths: { baseDir: "/tmp/mozi-base" },
      models: { providers: {} },
      agents: {},
    },
    configPath: "/tmp/mozi-base/config.jsonc",
    secrets: params?.secrets ?? createSecrets(),
    ui: params?.ui ?? createUi(),
    nonInteractive: params?.nonInteractive ?? false,
    persist: vi.fn(async () => {}),
  };
}

describe("providerSection", () => {
  beforeEach(() => {
    delete process.env.MOZI_PROVIDER;
    delete process.env.MOZI_PROVIDER_AUTH;
    delete process.env.MOZI_SECRET_SOURCE;
    delete process.env.MOZI_MODEL;
  });

  it("stores shared-storage credentials as env references for google without persisting canonical baseUrl", async () => {
    const ui = createUi({
      select: vi
        .fn()
        .mockResolvedValueOnce("add")
        .mockResolvedValueOnce({
          id: "google",
          label: "Google Gemini",
          auth: "api-key",
          authMethods: ["api-key"],
          defaultAuthMethod: "api-key",
          apiEnvVar: "GEMINI_API_KEY",
          secretSources: ["shared-storage", "direct-config", "external-env"],
          defaultApi: "google-generative-ai",
          defaultBaseUrl: "https://generativelanguage.googleapis.com",
          knownModels: [
            { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", api: "google-generative-ai" },
          ],
          defaultModelSuggestions: [],
        })
        .mockResolvedValueOnce("shared-storage")
        .mockResolvedValueOnce("gemini-2.5-flash"),
      confirm: vi.fn(async () => true),
      password: vi.fn(async () => "google-secret"),
    });
    const secrets = createSecrets();
    const ctx = createContext({ ui, secrets });

    const result = await providerSection.run(ctx);

    expect(result.modified).toBe(true);
    expect(secrets.__mocks.set).toHaveBeenCalledWith("GEMINI_API_KEY", "google-secret");
    expect(ctx.config.models?.providers?.google).toEqual({
      apiKey: "${GEMINI_API_KEY}",
      models: [{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", api: "google-generative-ai" }],
    });
  });

  it("supports external-env provider auth flow without writing direct secrets", async () => {
    process.env.MOZI_PROVIDER = "google";
    process.env.MOZI_PROVIDER_AUTH = "api-key";
    process.env.MOZI_SECRET_SOURCE = "external-env";
    process.env.MOZI_MODEL = "gemini-2.5-flash";
    const secrets = createSecrets();
    const ctx = createContext({ nonInteractive: true, secrets });

    const result = await providerSection.run(ctx);

    expect(result.modified).toBe(true);
    expect(secrets.__mocks.set).not.toHaveBeenCalled();
    expect(ctx.config.models?.providers?.google?.apiKey).toBe("${GEMINI_API_KEY}");
    expect(ctx.config.models?.providers?.google?.baseUrl).toBeUndefined();

    delete process.env.MOZI_PROVIDER;
    delete process.env.MOZI_PROVIDER_AUTH;
    delete process.env.MOZI_SECRET_SOURCE;
    delete process.env.MOZI_MODEL;
  });

  it("rejects openai-codex oauth onboarding with error", async () => {
    process.env.MOZI_PROVIDER = "openai-codex";
    process.env.MOZI_PROVIDER_AUTH = "oauth";
    process.env.MOZI_SECRET_SOURCE = "external-env";
    process.env.MOZI_MODEL = "gpt-5.3-codex";
    const secrets = createSecrets();
    const ctx = createContext({ nonInteractive: true, secrets });

    await expect(providerSection.run(ctx)).rejects.toThrow(
      /OAuth onboarding is no longer managed by mozi/,
    );
  });
});
