import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSecret } from "../storage/types";
import {
  AuthProfileStoreAdapter,
  calculateAuthProfileCooldownMs,
  resolveAuthProfileOrder,
  type AuthProfileRecord,
} from "./auth-profiles";

class InMemoryAuthSecretsRepo {
  private rows = new Map<string, AuthSecret>();

  list(params?: { scopeType?: "global" | "agent"; scopeId?: string }): AuthSecret[] {
    const rows = Array.from(this.rows.values());
    if (!params?.scopeType) {
      return rows;
    }
    return rows.filter(
      (row) => row.scope_type === params.scopeType && row.scope_id === (params.scopeId ?? ""),
    );
  }

  getExact(params: {
    name: string;
    scopeType: "global" | "agent";
    scopeId?: string;
  }): AuthSecret | null {
    return this.rows.get(`${params.scopeType}:${params.scopeId ?? ""}:${params.name}`) ?? null;
  }

  upsert(secret: {
    name: string;
    scopeType: "global" | "agent";
    scopeId?: string;
    valueCiphertext: Buffer;
    valueNonce: Buffer;
    createdBy?: string;
  }): void {
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

function createProfile(
  profile: Partial<AuthProfileRecord> & { id: string; provider: string },
): AuthProfileRecord {
  return {
    id: profile.id,
    credential: profile.credential ?? {
      type: "api_key",
      provider: profile.provider,
      key: `${profile.id}-key`,
    },
    usageStats: profile.usageStats,
  };
}

describe("auth profiles", () => {
  beforeEach(() => {
    process.env.MOZI_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  it("stores and resolves provider profiles from auth_secrets-backed adapter", () => {
    const repo = new InMemoryAuthSecretsRepo();
    const store = new AuthProfileStoreAdapter(repo);

    store.upsertProfile(createProfile({ id: "anthropic:default", provider: "anthropic" }));
    store.upsertProfile(createProfile({ id: "anthropic:work", provider: "anthropic" }));
    store.setProviderOrder("anthropic", ["anthropic:work", "anthropic:default"]);
    store.setLastGood("anthropic", "anthropic:default");

    expect(store.listProfiles().map((profile) => profile.id)).toEqual([
      "anthropic:default",
      "anthropic:work",
    ]);
    expect(store.getProviderOrder("anthropic")).toEqual(["anthropic:work", "anthropic:default"]);
    expect(store.getLastGood("anthropic")).toBe("anthropic:default");
    expect(store.resolveApiKey("anthropic")?.apiKey).toBe("anthropic:work-key");
  });

  it("orders by lastUsed when no explicit order exists", () => {
    const order = resolveAuthProfileOrder({
      providerId: "anthropic",
      profiles: [
        createProfile({ id: "anthropic:a", provider: "anthropic", usageStats: { lastUsed: 200 } }),
        createProfile({ id: "anthropic:b", provider: "anthropic", usageStats: { lastUsed: 100 } }),
        createProfile({ id: "anthropic:c", provider: "anthropic", usageStats: { lastUsed: 300 } }),
      ],
    });
    expect(order).toEqual(["anthropic:b", "anthropic:a", "anthropic:c"]);
  });

  it("pushes cooldown profiles to the end ordered by expiry", () => {
    const now = Date.now();
    const order = resolveAuthProfileOrder({
      providerId: "anthropic",
      now,
      profiles: [
        createProfile({
          id: "anthropic:ready",
          provider: "anthropic",
          usageStats: { lastUsed: 50 },
        }),
        createProfile({
          id: "anthropic:cool1",
          provider: "anthropic",
          usageStats: { cooldownUntil: now + 5_000 },
        }),
        createProfile({
          id: "anthropic:cool2",
          provider: "anthropic",
          usageStats: { cooldownUntil: now + 1_000 },
        }),
      ],
    });
    expect(order).toEqual(["anthropic:ready", "anthropic:cool2", "anthropic:cool1"]);
  });

  it("does not prioritize lastGood over explicit round-robin order", () => {
    const order = resolveAuthProfileOrder({
      providerId: "anthropic",
      explicitOrder: ["anthropic:default", "anthropic:work"],
      lastGoodProfileId: "anthropic:work",
      profiles: [
        createProfile({
          id: "anthropic:default",
          provider: "anthropic",
          usageStats: { lastUsed: 100 },
        }),
        createProfile({
          id: "anthropic:work",
          provider: "anthropic",
          usageStats: { lastUsed: 200, lastGoodAt: 999 },
        }),
      ],
    });
    expect(order[0]).toBe("anthropic:default");
  });

  it("normalizes provider aliases in profile order resolution", () => {
    const order = resolveAuthProfileOrder({
      providerId: "zai",
      explicitOrder: ["zai:work", "zai:default"],
      profiles: [
        createProfile({ id: "zai:default", provider: "z.ai" }),
        createProfile({ id: "zai:work", provider: "Z-AI" }),
      ],
    });
    expect(order).toEqual(["zai:work", "zai:default"]);
  });

  it("accepts oauth/token for oauth mode but rejects oauth for token mode", () => {
    const now = Date.now();
    const profiles: AuthProfileRecord[] = [
      {
        id: "anthropic:oauth",
        credential: {
          type: "oauth",
          provider: "anthropic",
          access: "oauth-access",
          refresh: "refresh",
          expires: now + 60_000,
        },
      },
      {
        id: "anthropic:token",
        credential: {
          type: "token",
          provider: "anthropic",
          token: "token-value",
          expires: now + 60_000,
        },
      },
    ];

    expect(
      resolveAuthProfileOrder({ providerId: "anthropic", profiles, authMode: "oauth", now }),
    ).toEqual(["anthropic:oauth", "anthropic:token"]);
    expect(
      resolveAuthProfileOrder({ providerId: "anthropic", profiles, authMode: "token", now }),
    ).toEqual(["anthropic:token"]);
  });

  it("marks transient failures with persisted cooldown and resets after expiry", () => {
    vi.useFakeTimers();
    const now = new Date("2026-03-13T12:00:00.000Z");
    vi.setSystemTime(now);

    const repo = new InMemoryAuthSecretsRepo();
    const store = new AuthProfileStoreAdapter(repo);
    store.upsertProfile(createProfile({ id: "anthropic:default", provider: "anthropic" }));

    store.markFailure("anthropic:default", "rate_limit");
    const first = store.getProfile("anthropic:default");
    expect(first?.usageStats?.errorCount).toBe(1);
    expect((first?.usageStats?.cooldownUntil ?? 0) - now.getTime()).toBe(60_000);

    vi.setSystemTime(new Date(now.getTime() + 120_000));
    store.markFailure("anthropic:default", "rate_limit");
    const second = store.getProfile("anthropic:default");
    expect(second?.usageStats?.errorCount).toBe(1);
    expect((second?.usageStats?.cooldownUntil ?? 0) - Date.now()).toBe(60_000);

    vi.useRealTimers();
  });

  it("marks billing failures as disabled windows", () => {
    const repo = new InMemoryAuthSecretsRepo();
    const store = new AuthProfileStoreAdapter(repo);
    store.upsertProfile(createProfile({ id: "anthropic:default", provider: "anthropic" }));

    const startedAt = Date.now();
    store.markFailure("anthropic:default", "billing");
    const stats = store.getProfile("anthropic:default")?.usageStats;

    expect(typeof stats?.disabledUntil).toBe("number");
    expect((stats?.disabledUntil ?? 0) - startedAt).toBeGreaterThan(4.5 * 60 * 60 * 1000);
    expect(stats?.disabledReason).toBe("billing");
    expect(stats?.cooldownUntil).toBeUndefined();
  });
});

describe("calculateAuthProfileCooldownMs", () => {
  it("applies exponential backoff with 1h cap", () => {
    expect(calculateAuthProfileCooldownMs(1)).toBe(60_000);
    expect(calculateAuthProfileCooldownMs(2)).toBe(5 * 60_000);
    expect(calculateAuthProfileCooldownMs(3)).toBe(25 * 60_000);
    expect(calculateAuthProfileCooldownMs(4)).toBe(60 * 60_000);
    expect(calculateAuthProfileCooldownMs(5)).toBe(60 * 60_000);
  });
});
