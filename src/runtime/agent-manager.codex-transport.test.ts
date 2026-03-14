import type {
  AssistantMessageEventStream,
  Context,
  Model,
  StreamFunction,
  StreamOptions,
} from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createCodexDefaultTransportWrapper, inferAuthProfileFailureReason } from "./agent-manager";
import { AuthProfileStoreAdapter } from "./auth-profiles";

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

describe("createCodexDefaultTransportWrapper", () => {
  function makeProfileStore() {
    process.env.MOZI_MASTER_KEY = Buffer.alloc(32, 3).toString("base64");
    const store = new AuthProfileStoreAdapter(new InMemoryAuthSecretsRepo());
    store.upsertProfile({
      id: "openai-codex:default",
      credential: {
        type: "oauth",
        provider: "openai-codex",
        access: "profile-key",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      },
    });
    return store;
  }

  function makeModel(): Model<"openai-codex-responses"> {
    return {
      id: "codex-mini-latest",
      name: "Codex Mini",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    };
  }

  function makeContext(): Context {
    return { messages: [] };
  }

  function makeMockStream(): AssistantMessageEventStream {
    return {} as AssistantMessageEventStream;
  }

  it("defaults to transport: auto when no transport is set", () => {
    const capturedOptions: (StreamOptions | undefined)[] = [];
    const base = vi.fn(
      (
        _model: Model<"openai-codex-responses">,
        _context: Context,
        options?: StreamOptions,
      ): AssistantMessageEventStream => {
        capturedOptions.push(options);
        return makeMockStream();
      },
    );

    const wrapped = createCodexDefaultTransportWrapper(base as unknown as StreamFunction);
    wrapped(makeModel(), makeContext(), {});

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.transport).toBe("auto");
  });

  it("preserves explicitly set transport value", () => {
    const capturedOptions: (StreamOptions | undefined)[] = [];
    const base = vi.fn(
      (
        _model: Model<"openai-codex-responses">,
        _context: Context,
        options?: StreamOptions,
      ): AssistantMessageEventStream => {
        capturedOptions.push(options);
        return makeMockStream();
      },
    );

    const wrapped = createCodexDefaultTransportWrapper(base as unknown as StreamFunction);
    wrapped(makeModel(), makeContext(), { transport: "sse" });

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.transport).toBe("sse");
  });

  it("preserves explicitly set websocket transport", () => {
    const capturedOptions: (StreamOptions | undefined)[] = [];
    const base = vi.fn(
      (
        _model: Model<"openai-codex-responses">,
        _context: Context,
        options?: StreamOptions,
      ): AssistantMessageEventStream => {
        capturedOptions.push(options);
        return makeMockStream();
      },
    );

    const wrapped = createCodexDefaultTransportWrapper(base as unknown as StreamFunction);
    wrapped(makeModel(), makeContext(), { transport: "websocket" });

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.transport).toBe("websocket");
  });

  it("defaults to transport: auto when options is undefined", () => {
    const capturedOptions: (StreamOptions | undefined)[] = [];
    const base = vi.fn(
      (
        _model: Model<"openai-codex-responses">,
        _context: Context,
        options?: StreamOptions,
      ): AssistantMessageEventStream => {
        capturedOptions.push(options);
        return makeMockStream();
      },
    );

    const wrapped = createCodexDefaultTransportWrapper(base as unknown as StreamFunction);
    wrapped(makeModel(), makeContext(), undefined);

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.transport).toBe("auto");
  });

  it("preserves other options alongside transport default", () => {
    const capturedOptions: (StreamOptions | undefined)[] = [];
    const base = vi.fn(
      (
        _model: Model<"openai-codex-responses">,
        _context: Context,
        options?: StreamOptions,
      ): AssistantMessageEventStream => {
        capturedOptions.push(options);
        return makeMockStream();
      },
    );

    const wrapped = createCodexDefaultTransportWrapper(base as unknown as StreamFunction);
    wrapped(makeModel(), makeContext(), { temperature: 0.5, maxTokens: 1024 });

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.transport).toBe("auto");
    expect(capturedOptions[0]?.temperature).toBe(0.5);
    expect(capturedOptions[0]?.maxTokens).toBe(1024);
  });

  it("forwards model and context to underlying function", () => {
    const capturedModels: Model<"openai-codex-responses">[] = [];
    const capturedContexts: Context[] = [];
    const base = vi.fn(
      (
        model: Model<"openai-codex-responses">,
        context: Context,
        _options?: StreamOptions,
      ): AssistantMessageEventStream => {
        capturedModels.push(model);
        capturedContexts.push(context);
        return makeMockStream();
      },
    );

    const model = makeModel();
    const context = makeContext();
    const wrapped = createCodexDefaultTransportWrapper(base as unknown as StreamFunction);
    wrapped(model, context);

    expect(capturedModels[0]).toBe(model);
    expect(capturedContexts[0]).toBe(context);
  });

  it("uses streamSimple as default when no base function is provided", () => {
    const wrapped = createCodexDefaultTransportWrapper();
    expect(typeof wrapped).toBe("function");
  });

  it("marks auth-profile success as used and good", () => {
    const store = makeProfileStore();
    const base = vi.fn(() => makeMockStream());
    const wrapped = createCodexDefaultTransportWrapper(base as unknown as StreamFunction, {
      authProfiles: store,
      profileId: "openai-codex:default",
    });

    wrapped(makeModel(), makeContext());

    const profile = store.getProfile("openai-codex:default");
    expect(typeof profile?.usageStats?.lastUsed).toBe("number");
    expect(typeof profile?.usageStats?.lastGoodAt).toBe("number");
    expect(store.getLastGood("openai-codex")).toBe("openai-codex:default");
  });

  it("marks auth-profile failures with inferred cooldown reason", () => {
    const store = makeProfileStore();
    const base = vi.fn(() => {
      throw new Error("429 rate limit exceeded");
    });
    const wrapped = createCodexDefaultTransportWrapper(base as unknown as StreamFunction, {
      authProfiles: store,
      profileId: "openai-codex:default",
    });

    expect(() => wrapped(makeModel(), makeContext())).toThrow(/rate limit/i);
    const profile = store.getProfile("openai-codex:default");
    expect(profile?.usageStats?.failureCounts?.rate_limit).toBe(1);
    expect(typeof profile?.usageStats?.cooldownUntil).toBe("number");
  });
});

describe("inferAuthProfileFailureReason", () => {
  it("maps billing/auth/rate-limit/overloaded errors", () => {
    expect(inferAuthProfileFailureReason(new Error("402 billing required"))).toBe("billing");
    expect(inferAuthProfileFailureReason(new Error("401 unauthorized"))).toBe("auth_permanent");
    expect(inferAuthProfileFailureReason(new Error("429 rate limit"))).toBe("rate_limit");
    expect(inferAuthProfileFailureReason(new Error("503 service unavailable"))).toBe("overloaded");
  });
});
