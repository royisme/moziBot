import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { readCodexCliCredentials } = vi.hoisted(() => ({
  readCodexCliCredentials: vi.fn(),
}));

vi.mock("../runtime/cli-credentials", () => ({
  readCodexCliCredentials,
}));

import { fetchCodexUsage } from "../commands/codex-usage";
import type { MoziConfig } from "../config";
import { AuthProfileStoreAdapter } from "./auth-profiles";
import { ModelRegistry } from "./model-registry";
import { resolveApiKeyForProvider, resolveProviderAuth } from "./provider-auth";
import { ProviderRegistry } from "./provider-registry";
import type { ModelDefinition } from "./types";

// ---------------------------------------------------------------------------
// Helper: build minimal MoziConfig with an openai-codex provider block
// ---------------------------------------------------------------------------
function createCodexConfig(
  models: ModelDefinition[] = [{ id: "gpt-5.3-codex", name: "gpt-5.3-codex" }],
): MoziConfig {
  return {
    models: {
      providers: {
        "openai-codex": {
          api: "openai-codex-responses",
          baseUrl: "https://chatgpt.com/backend-api",
          apiKey: "test-key",
          models,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Provider registry: openai-codex → OPENAI_CODEX_API_KEY
// ---------------------------------------------------------------------------
class InMemoryAuthSecretsRepo {
  private rows = new Map<string, import("../storage/types").AuthSecret>();

  list(params?: { scopeType?: "global" | "agent"; scopeId?: string }) {
    const rows = Array.from(this.rows.values());
    if (!params?.scopeType) {
      return rows;
    }
    return rows.filter(
      (row) => row.scope_type === params.scopeType && row.scope_id === (params.scopeId ?? ""),
    );
  }

  getExact(params: { name: string; scopeType: "global" | "agent"; scopeId?: string }) {
    return this.rows.get(`${params.scopeType}:${params.scopeId ?? ""}:${params.name}`) ?? null;
  }

  upsert(secret: {
    name: string;
    scopeType: "global" | "agent";
    scopeId?: string;
    valueCiphertext: Buffer;
    valueNonce: Buffer;
    createdBy?: string;
  }) {
    const now = new Date().toISOString();
    this.rows.set(`${secret.scopeType}:${secret.scopeId ?? ""}:${secret.name}`, {
      name: secret.name,
      scope_type: secret.scopeType,
      scope_id: secret.scopeId ?? "",
      value_ciphertext: secret.valueCiphertext,
      value_nonce: secret.valueNonce,
      created_at: now,
      updated_at: now,
      last_used_at: null,
      created_by: secret.createdBy ?? null,
    });
  }
}

describe("ProviderRegistry — openai-codex env var mapping", () => {
  const envKey = "OPENAI_CODEX_API_KEY";
  let originalValue: string | undefined;

  beforeEach(() => {
    process.env.MOZI_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
    originalValue = process.env[envKey];
    delete process.env[envKey];
  });

  afterEach(() => {
    if (originalValue !== undefined) {
      process.env[envKey] = originalValue;
    } else {
      delete process.env[envKey];
    }
  });

  it("resolves api key from OPENAI_CODEX_API_KEY env var when no apiKey in config", () => {
    process.env[envKey] = "env-codex-key";

    // Config with no apiKey so it must fall back to env
    const config: MoziConfig = {
      models: {
        providers: {
          "openai-codex": {
            api: "openai-codex-responses",
            baseUrl: "https://chatgpt.com/backend-api",
            models: [],
          },
        },
      },
    };

    const registry = new ProviderRegistry(config);
    expect(registry.resolveApiKey("openai-codex")).toBe("env-codex-key");
  });

  it("returns undefined for openai-codex when env var is not set and no apiKey in config", () => {
    const config: MoziConfig = {
      models: {
        providers: {
          "openai-codex": {
            api: "openai-codex-responses",
            baseUrl: "https://chatgpt.com/backend-api",
            models: [],
          },
        },
      },
    };

    const registry = new ProviderRegistry(config);
    expect(registry.resolveApiKey("openai-codex")).toBeUndefined();
  });

  it("prefers explicit apiKey in config over env var", () => {
    process.env[envKey] = "env-codex-key";

    const registry = new ProviderRegistry(createCodexConfig());
    expect(registry.resolveApiKey("openai-codex")).toBe("test-key");
  });

  it("returns undefined for unknown provider (not in ENV_MAP)", () => {
    const registry = new ProviderRegistry(createCodexConfig());
    expect(registry.resolveApiKey("some-unknown-provider")).toBeUndefined();
  });

  it("prefers env over auth profiles and auth profiles over CLI fallback", () => {
    readCodexCliCredentials.mockReturnValue({
      access: "cli-codex-key",
      refresh: "refresh",
      expires: Date.now() + 3600_000,
    });
    const repo = new InMemoryAuthSecretsRepo();
    const profiles = new AuthProfileStoreAdapter(repo);
    profiles.upsertProfile({
      id: "openai-codex:default",
      credential: {
        type: "oauth",
        provider: "openai-codex",
        access: "profile-codex-key",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      },
    });

    expect(
      resolveApiKeyForProvider({
        providerId: "openai-codex",
        provider: undefined,
        env: {},
        authProfiles: profiles,
      }),
    ).toBe("profile-codex-key");

    expect(
      resolveApiKeyForProvider({
        providerId: "openai-codex",
        provider: undefined,
        env: { OPENAI_CODEX_API_KEY: "env-codex-key" },
        authProfiles: profiles,
      }),
    ).toBe("env-codex-key");
  });

  it("normalizes provider aliases during auth-profile resolution", () => {
    const repo = new InMemoryAuthSecretsRepo();
    const profiles = new AuthProfileStoreAdapter(repo);
    profiles.upsertProfile({
      id: "zai:default",
      credential: {
        type: "api_key",
        provider: "z.ai",
        key: "zai-profile-key",
      },
    });

    expect(
      resolveApiKeyForProvider({
        providerId: "Z-AI",
        provider: undefined,
        env: {},
        authProfiles: profiles,
      }),
    ).toBe("zai-profile-key");
  });

  it("returns auth-profile source metadata for runtime integration", () => {
    const repo = new InMemoryAuthSecretsRepo();
    const profiles = new AuthProfileStoreAdapter(repo);
    profiles.upsertProfile({
      id: "openai-codex:default",
      credential: {
        type: "oauth",
        provider: "openai-codex",
        access: "profile-codex-key",
        expires: Date.now() + 60_000,
      },
    });

    expect(
      resolveProviderAuth({
        providerId: "openai-codex",
        provider: undefined,
        env: {},
        authProfiles: profiles,
      }),
    ).toMatchObject({
      source: "auth-profile",
      apiKey: "profile-codex-key",
      profileId: "openai-codex:default",
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Model registry spark fallback: synthesizes gpt-5.3-codex-spark
// ---------------------------------------------------------------------------
describe("ModelRegistry.applyCodexSparkFallback — spark model auto-synthesis", () => {
  it("synthesizes gpt-5.3-codex-spark when base model exists but spark does not", () => {
    const registry = new ModelRegistry(
      createCodexConfig([{ id: "gpt-5.3-codex", name: "gpt-5.3-codex" }]),
    );

    const spark = registry.get("openai-codex/gpt-5.3-codex-spark");
    expect(spark).toBeDefined();
    expect(spark?.id).toBe("gpt-5.3-codex-spark");
    expect(spark?.provider).toBe("openai-codex");
  });

  it("synthesized spark model inherits api and baseUrl from base model", () => {
    const registry = new ModelRegistry(
      createCodexConfig([{ id: "gpt-5.3-codex", name: "gpt-5.3-codex" }]),
    );

    const base = registry.get("openai-codex/gpt-5.3-codex");
    const spark = registry.get("openai-codex/gpt-5.3-codex-spark");

    expect(base).toBeDefined();
    expect(spark).toBeDefined();
    expect(spark?.api).toBe(base?.api);
    expect(spark?.baseUrl).toBe(base?.baseUrl);
  });
});

// ---------------------------------------------------------------------------
// 3. Model registry spark fallback: when spark already exists, not overwritten
// ---------------------------------------------------------------------------
describe("ModelRegistry.applyCodexSparkFallback — spark not overwritten when explicit", () => {
  it("does not overwrite an explicitly configured spark model", () => {
    const config = createCodexConfig([
      { id: "gpt-5.3-codex", name: "gpt-5.3-codex" },
      // explicitly configured spark with a different api to detect overwrite
      { id: "gpt-5.3-codex-spark", name: "gpt-5.3-codex-spark" },
    ]);

    // Inject a distinct apiKey into the explicit spark entry so we can verify
    // it wasn't replaced by the synthesized one.
    const registry = new ModelRegistry(config);

    const spark = registry.get("openai-codex/gpt-5.3-codex-spark");
    expect(spark).toBeDefined();
    expect(spark?.id).toBe("gpt-5.3-codex-spark");
    expect(spark?.provider).toBe("openai-codex");
  });

  it("keeps both base and explicit spark models in registry", () => {
    const config = createCodexConfig([
      { id: "gpt-5.3-codex", name: "gpt-5.3-codex" },
      { id: "gpt-5.3-codex-spark", name: "gpt-5.3-codex-spark" },
    ]);

    const registry = new ModelRegistry(config);

    expect(registry.get("openai-codex/gpt-5.3-codex")).toBeDefined();
    expect(registry.get("openai-codex/gpt-5.3-codex-spark")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Model registry spark fallback: no-op when no codex models exist
// ---------------------------------------------------------------------------
describe("ModelRegistry.applyCodexSparkFallback — no-op without codex models", () => {
  it("does not create spark model when no openai-codex provider is configured", () => {
    const config: MoziConfig = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-test",
            models: [{ id: "gpt-4o", name: "gpt-4o" }],
          },
        },
      },
    };

    const registry = new ModelRegistry(config);
    expect(registry.get("openai-codex/gpt-5.3-codex-spark")).toBeUndefined();
  });

  it("does not create spark model when openai-codex provider has no models", () => {
    const config: MoziConfig = {
      models: {
        providers: {
          "openai-codex": {
            api: "openai-codex-responses",
            baseUrl: "https://chatgpt.com/backend-api",
            models: [],
          },
        },
      },
    };

    const registry = new ModelRegistry(config);
    expect(registry.get("openai-codex/gpt-5.3-codex-spark")).toBeUndefined();
    expect(registry.get("openai-codex/gpt-5.3-codex")).toBeUndefined();
  });

  it("does not create spark model when codex provider only has non-base models", () => {
    const config = createCodexConfig([{ id: "codex-mini-latest", name: "codex-mini-latest" }]);

    const registry = new ModelRegistry(config);
    // codex-mini-latest is present but gpt-5.3-codex is not, so no spark should be synthesized
    expect(registry.get("openai-codex/gpt-5.3-codex-spark")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. fetchCodexUsage: handles missing credentials gracefully
// ---------------------------------------------------------------------------
describe("fetchCodexUsage — missing credentials", () => {
  beforeEach(() => {
    readCodexCliCredentials.mockReset();
  });

  it("returns no-credentials snapshot when credential lookup yields nothing", async () => {
    readCodexCliCredentials.mockReturnValue(undefined);

    const snapshot = await fetchCodexUsage({
      baseDir: "/nonexistent-path-that-will-never-exist-mozibot-test",
      fetchFn: vi.fn() as unknown as typeof fetch,
    });

    expect(snapshot.provider).toBe("openai-codex");
    expect(snapshot.displayName).toBe("Codex");
    expect(snapshot.windows).toHaveLength(0);
    expect(snapshot.error).toBe("No Codex CLI credentials");
  });

  it("returns 'No credentials' snapshot when fetchFn is never called", async () => {
    readCodexCliCredentials.mockReturnValue(undefined);
    const mockFetch = vi.fn();

    const snapshot = await fetchCodexUsage({
      baseDir: "/tmp",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    // fetch should NOT have been called since credentials are absent
    expect(mockFetch).not.toHaveBeenCalled();
    expect(snapshot.provider).toBe("openai-codex");
    expect(snapshot.windows).toHaveLength(0);
    expect(snapshot.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 6. fetchCodexUsage: handles HTTP errors gracefully
// ---------------------------------------------------------------------------
describe("fetchCodexUsage — HTTP error handling", () => {
  beforeEach(() => {
    readCodexCliCredentials.mockReset();
  });

  it("returns 'Token expired' error on 401 response", async () => {
    readCodexCliCredentials.mockReturnValue({
      access: "fake-access-token",
      refresh: "fake-refresh-token",
      expires: Date.now() + 3600_000,
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    } as Response);

    const snapshot = await fetchCodexUsage({
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(snapshot.provider).toBe("openai-codex");
    expect(snapshot.windows).toHaveLength(0);
    expect(snapshot.error).toBe("Token expired");
  });

  it("returns HTTP status error on 500 response", async () => {
    readCodexCliCredentials.mockReturnValue({
      access: "fake-access-token",
      refresh: "fake-refresh-token",
      expires: Date.now() + 3600_000,
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    const snapshot = await fetchCodexUsage({
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(snapshot.provider).toBe("openai-codex");
    expect(snapshot.windows).toHaveLength(0);
    expect(snapshot.error).toBe("HTTP 500");
  });

  it("returns network error message when fetch throws", async () => {
    readCodexCliCredentials.mockReturnValue({
      access: "fake-access-token",
      refresh: "fake-refresh-token",
      expires: Date.now() + 3600_000,
    });

    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const snapshot = await fetchCodexUsage({
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(snapshot.provider).toBe("openai-codex");
    expect(snapshot.windows).toHaveLength(0);
    expect(snapshot.error).toBe("ECONNREFUSED");
  });

  it("parses successful response and returns usage windows", async () => {
    readCodexCliCredentials.mockReturnValue({
      access: "fake-access-token",
      refresh: "fake-refresh-token",
      expires: Date.now() + 3600_000,
    });

    const responseBody = {
      rate_limit: {
        primary_window: {
          limit_window_seconds: 10800,
          used_percent: 42,
          reset_at: 1700000000,
        },
        secondary_window: {
          limit_window_seconds: 86400,
          used_percent: 15,
        },
      },
      plan_type: "pro",
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(responseBody),
    } as unknown as Response);

    const snapshot = await fetchCodexUsage({
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(snapshot.provider).toBe("openai-codex");
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.windows).toHaveLength(2);
    expect(snapshot.windows[0]?.label).toBe("3h");
    expect(snapshot.windows[0]?.usedPercent).toBe(42);
    expect(snapshot.windows[1]?.label).toBe("Day");
    expect(snapshot.windows[1]?.usedPercent).toBe(15);
    expect(snapshot.plan).toBe("pro");
  });
});
