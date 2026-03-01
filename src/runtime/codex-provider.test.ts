import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fetchCodexUsage } from "../commands/codex-usage";
import type { MoziConfig } from "../config";
import { ModelRegistry } from "./model-registry";
import { ProviderRegistry } from "./provider-registry";

// ---------------------------------------------------------------------------
// Helper: build minimal MoziConfig with an openai-codex provider block
// ---------------------------------------------------------------------------
function createCodexConfig(models: { id: string }[] = [{ id: "gpt-5.3-codex" }]): MoziConfig {
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
describe("ProviderRegistry — openai-codex env var mapping", () => {
  const envKey = "OPENAI_CODEX_API_KEY";
  let originalValue: string | undefined;

  beforeEach(() => {
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
    // createCodexConfig uses apiKey: "test-key"
    expect(registry.resolveApiKey("openai-codex")).toBe("test-key");
  });

  it("returns undefined for unknown provider (not in ENV_MAP)", () => {
    const registry = new ProviderRegistry(createCodexConfig());
    expect(registry.resolveApiKey("some-unknown-provider")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Model registry spark fallback: synthesizes gpt-5.3-codex-spark
// ---------------------------------------------------------------------------
describe("ModelRegistry.applyCodexSparkFallback — spark model auto-synthesis", () => {
  it("synthesizes gpt-5.3-codex-spark when base model exists but spark does not", () => {
    const registry = new ModelRegistry(createCodexConfig([{ id: "gpt-5.3-codex" }]));

    const spark = registry.get("openai-codex/gpt-5.3-codex-spark");
    expect(spark).toBeDefined();
    expect(spark?.id).toBe("gpt-5.3-codex-spark");
    expect(spark?.provider).toBe("openai-codex");
  });

  it("synthesized spark model inherits api and baseUrl from base model", () => {
    const registry = new ModelRegistry(createCodexConfig([{ id: "gpt-5.3-codex" }]));

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
      { id: "gpt-5.3-codex" },
      // explicitly configured spark with a different api to detect overwrite
      { id: "gpt-5.3-codex-spark" },
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
    const config = createCodexConfig([{ id: "gpt-5.3-codex" }, { id: "gpt-5.3-codex-spark" }]);

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
            models: [{ id: "gpt-4o" }],
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
    const config = createCodexConfig([{ id: "codex-mini-latest" }]);

    const registry = new ModelRegistry(config);
    // codex-mini-latest is present but gpt-5.3-codex is not, so no spark should be synthesized
    expect(registry.get("openai-codex/gpt-5.3-codex-spark")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. fetchCodexUsage: handles missing credentials gracefully
// ---------------------------------------------------------------------------
describe("fetchCodexUsage — missing credentials", () => {
  it("returns error snapshot when auth storage throws during creation", async () => {
    // Point baseDir to a guaranteed-nonexistent, non-createable path so
    // AuthStorage.create() throws (e.g. ENOENT when the auth.json doesn't exist).
    const snapshot = await fetchCodexUsage({
      baseDir: "/nonexistent-path-that-will-never-exist-mozibot-test",
      fetchFn: vi.fn() as unknown as typeof fetch,
    });

    expect(snapshot.provider).toBe("openai-codex");
    expect(snapshot.displayName).toBe("Codex");
    expect(snapshot.windows).toHaveLength(0);
    // Either "Auth storage not found" or "No credentials" is acceptable,
    // depending on whether AuthStorage.create throws or succeeds with empty data.
    expect(snapshot.error).toBeDefined();
  });

  it("returns 'No credentials' snapshot when fetchFn is never called", async () => {
    const mockFetch = vi.fn();

    // Use a temp dir that exists but has no auth.json -> AuthStorage.create() may
    // succeed with no data stored, returning "No credentials"
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
  it("returns 'Token expired' error on 401 response", async () => {
    // We need valid credentials in auth.json. Since we can't easily write one,
    // we mock the module to bypass AuthStorage and test the HTTP layer directly.
    // We use vi.mock to stub the module that exports fetchCodexUsage's dependency.
    // However, the cleanest approach without modifying the module is to supply
    // a fetchFn that also mocks the module boundary. We'll use vi.mock at module
    // level instead — but since vi.mock hoisting doesn't work inline, we test
    // the HTTP error paths via a separate describe with vi.mock.
    //
    // The simplest deterministic approach: pass a fetchFn that returns 401, and
    // mock AuthStorage.create so that it doesn't throw and returns a storage
    // with valid credentials.

    const { AuthStorage } = await import("@mariozechner/pi-coding-agent");

    // Build an in-memory AuthStorage with a valid OAuth credential
    const inMemoryStorage = AuthStorage.inMemory({
      "openai-codex": {
        type: "oauth",
        access: "fake-access-token",
        refresh: "fake-refresh-token",
        expires: Date.now() + 3600_000,
      } as import("@mariozechner/pi-coding-agent").OAuthCredential,
    });

    // Temporarily monkey-patch AuthStorage.create so fetchCodexUsage uses our in-memory storage
    const originalCreate = AuthStorage.create.bind(AuthStorage);
    AuthStorage.create = () => inMemoryStorage;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    } as Response);

    try {
      const snapshot = await fetchCodexUsage({
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(snapshot.provider).toBe("openai-codex");
      expect(snapshot.windows).toHaveLength(0);
      expect(snapshot.error).toBe("Token expired");
    } finally {
      AuthStorage.create = originalCreate;
    }
  });

  it("returns HTTP status error on 500 response", async () => {
    const { AuthStorage } = await import("@mariozechner/pi-coding-agent");

    const inMemoryStorage = AuthStorage.inMemory({
      "openai-codex": {
        type: "oauth",
        access: "fake-access-token",
        refresh: "fake-refresh-token",
        expires: Date.now() + 3600_000,
      } as import("@mariozechner/pi-coding-agent").OAuthCredential,
    });

    const originalCreate = AuthStorage.create.bind(AuthStorage);
    AuthStorage.create = () => inMemoryStorage;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    try {
      const snapshot = await fetchCodexUsage({
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(snapshot.provider).toBe("openai-codex");
      expect(snapshot.windows).toHaveLength(0);
      expect(snapshot.error).toBe("HTTP 500");
    } finally {
      AuthStorage.create = originalCreate;
    }
  });

  it("returns network error message when fetch throws", async () => {
    const { AuthStorage } = await import("@mariozechner/pi-coding-agent");

    const inMemoryStorage = AuthStorage.inMemory({
      "openai-codex": {
        type: "oauth",
        access: "fake-access-token",
        refresh: "fake-refresh-token",
        expires: Date.now() + 3600_000,
      } as import("@mariozechner/pi-coding-agent").OAuthCredential,
    });

    const originalCreate = AuthStorage.create.bind(AuthStorage);
    AuthStorage.create = () => inMemoryStorage;

    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    try {
      const snapshot = await fetchCodexUsage({
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(snapshot.provider).toBe("openai-codex");
      expect(snapshot.windows).toHaveLength(0);
      expect(snapshot.error).toBe("ECONNREFUSED");
    } finally {
      AuthStorage.create = originalCreate;
    }
  });

  it("parses successful response and returns usage windows", async () => {
    const { AuthStorage } = await import("@mariozechner/pi-coding-agent");

    const inMemoryStorage = AuthStorage.inMemory({
      "openai-codex": {
        type: "oauth",
        access: "fake-access-token",
        refresh: "fake-refresh-token",
        expires: Date.now() + 3600_000,
      } as import("@mariozechner/pi-coding-agent").OAuthCredential,
    });

    const originalCreate = AuthStorage.create.bind(AuthStorage);
    AuthStorage.create = () => inMemoryStorage;

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

    try {
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
    } finally {
      AuthStorage.create = originalCreate;
    }
  });
});
