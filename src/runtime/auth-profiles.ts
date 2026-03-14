import { authSecrets } from "../storage/repos/auth-secrets";
import type { AuthSecret } from "../storage/types";
import { encryptSecret, decryptSecret, resolveMasterKey } from "./auth/crypto";
import { normalizeProviderIdForAuth } from "./provider-normalization";
import type { ModelProviderAuthMode } from "./types";

const PROFILE_PREFIX = "auth-profile:";
const ORDER_PREFIX = "auth-profile-order:";
const LAST_GOOD_PREFIX = "auth-profile-last-good:";
const DEFAULT_BILLING_DISABLE_MS = 5 * 60 * 60 * 1000;

type AuthProfileScope = {
  scopeType: "global" | "agent";
  scopeId?: string;
};

export type AuthProfileFailureReason =
  | "rate_limit"
  | "overloaded"
  | "billing"
  | "auth_permanent"
  | "unknown";

export type ApiKeyCredential = {
  type: "api_key";
  provider: string;
  key: string;
};

export type TokenCredential = {
  type: "token";
  provider: string;
  token: string;
  expires?: number;
};

export type OAuthCredential = {
  type: "oauth";
  provider: string;
  access: string;
  refresh?: string;
  expires?: number;
};

export type AuthProfileCredential = ApiKeyCredential | TokenCredential | OAuthCredential;

export type ProfileUsageStats = {
  lastUsed?: number;
  cooldownUntil?: number;
  disabledUntil?: number;
  disabledReason?: Exclude<AuthProfileFailureReason, "rate_limit" | "overloaded" | "unknown">;
  errorCount?: number;
  lastFailureAt?: number;
  failureCounts?: Partial<Record<AuthProfileFailureReason, number>>;
  lastGoodAt?: number;
};

export type AuthProfileRecord = {
  id: string;
  credential: AuthProfileCredential;
  usageStats?: ProfileUsageStats;
  createdAt?: number;
  updatedAt?: number;
};

type StoredPayload = {
  id: string;
  credential: AuthProfileCredential;
  usageStats?: ProfileUsageStats;
  createdAt?: number;
  updatedAt?: number;
};

type SecretInsert = {
  name: string;
  scopeType: "global" | "agent";
  scopeId?: string;
  valueCiphertext: Buffer;
  valueNonce: Buffer;
  createdBy?: string;
};

type AuthSecretsRepository = {
  list(params?: { scopeType?: "global" | "agent"; scopeId?: string }): AuthSecret[];
  getExact(params: {
    name: string;
    scopeType: "global" | "agent";
    scopeId?: string;
  }): AuthSecret | null;
  upsert(secret: SecretInsert): void;
};

export class AuthProfileStoreAdapter {
  constructor(
    private readonly repo: AuthSecretsRepository = authSecrets,
    private readonly masterKeyEnv = "MOZI_MASTER_KEY",
  ) {}

  listProfiles(scope: AuthProfileScope = { scopeType: "global" }): AuthProfileRecord[] {
    const rows = this.repo.list({ scopeType: scope.scopeType, scopeId: scope.scopeId });
    return rows
      .filter((row) => row.name.startsWith(PROFILE_PREFIX))
      .flatMap((row) => {
        const payload = this.deserializeRow(row);
        return payload ? [payload] : [];
      })
      .toSorted((left, right) => left.id.localeCompare(right.id));
  }

  upsertProfile(
    profile: AuthProfileRecord,
    scope: AuthProfileScope = { scopeType: "global" },
    createdBy?: string,
  ): void {
    const existing = this.getProfile(profile.id, scope);
    const payload: StoredPayload = {
      id: profile.id,
      credential: {
        ...profile.credential,
        provider: normalizeProviderIdForAuth(profile.credential.provider),
      },
      usageStats: profile.usageStats,
      createdAt: existing?.createdAt ?? profile.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    this.saveJsonSecret(this.profileSecretName(profile.id), payload, scope, createdBy);
  }

  getProfile(
    id: string,
    scope: AuthProfileScope = { scopeType: "global" },
  ): AuthProfileRecord | undefined {
    const row = this.repo.getExact({
      name: this.profileSecretName(id),
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
    });
    return row ? (this.deserializeRow(row) ?? undefined) : undefined;
  }

  getProviderOrder(
    providerId: string,
    scope: AuthProfileScope = { scopeType: "global" },
  ): string[] {
    const normalized = normalizeProviderIdForAuth(providerId);
    const row = this.repo.getExact({
      name: `${ORDER_PREFIX}${normalized}`,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
    });
    if (!row) {
      return [];
    }
    const payload = this.deserializeJsonRow(row) as { ids?: unknown } | null;
    return Array.isArray(payload?.ids)
      ? payload.ids.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [];
  }

  setProviderOrder(
    providerId: string,
    ids: string[],
    scope: AuthProfileScope = { scopeType: "global" },
    createdBy?: string,
  ): void {
    this.saveJsonSecret(
      `${ORDER_PREFIX}${normalizeProviderIdForAuth(providerId)}`,
      { ids: dedupeProfileIds(ids) },
      scope,
      createdBy,
    );
  }

  getLastGood(
    providerId: string,
    scope: AuthProfileScope = { scopeType: "global" },
  ): string | undefined {
    const normalized = normalizeProviderIdForAuth(providerId);
    const row = this.repo.getExact({
      name: `${LAST_GOOD_PREFIX}${normalized}`,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
    });
    if (!row) {
      return undefined;
    }
    const payload = this.deserializeJsonRow(row) as { profileId?: unknown } | null;
    return typeof payload?.profileId === "string" && payload.profileId.trim()
      ? payload.profileId
      : undefined;
  }

  setLastGood(
    providerId: string,
    profileId: string,
    scope: AuthProfileScope = { scopeType: "global" },
    createdBy?: string,
  ): void {
    this.saveJsonSecret(
      `${LAST_GOOD_PREFIX}${normalizeProviderIdForAuth(providerId)}`,
      { profileId },
      scope,
      createdBy,
    );
  }

  markUsed(profileId: string, scope: AuthProfileScope = { scopeType: "global" }): void {
    const existing = this.getProfile(profileId, scope);
    if (!existing) {
      return;
    }
    this.upsertProfile(
      {
        ...existing,
        usageStats: {
          ...existing.usageStats,
          lastUsed: Date.now(),
        },
      },
      scope,
    );
  }

  markGood(profileId: string, scope: AuthProfileScope = { scopeType: "global" }): void {
    const existing = this.getProfile(profileId, scope);
    if (!existing) {
      return;
    }
    const providerId = normalizeProviderIdForAuth(existing.credential.provider);
    this.setLastGood(providerId, profileId, scope);
    this.upsertProfile(
      {
        ...existing,
        usageStats: {
          ...existing.usageStats,
          lastGoodAt: Date.now(),
          errorCount: 0,
          cooldownUntil: undefined,
          disabledUntil: undefined,
          disabledReason: undefined,
        },
      },
      scope,
    );
  }

  markFailure(
    profileId: string,
    reason: AuthProfileFailureReason,
    scope: AuthProfileScope = { scopeType: "global" },
  ): void {
    const existing = this.getProfile(profileId, scope);
    if (!existing) {
      return;
    }
    const now = Date.now();
    const usage = { ...existing.usageStats };
    const previousFailureAt = usage.lastFailureAt;
    const previousCooldownUntil = usage.cooldownUntil;
    const failureWindowMs = 24 * 60 * 60 * 1000;
    const expiredCooldown =
      typeof previousCooldownUntil === "number" && previousCooldownUntil <= now;
    const outsideWindow =
      typeof previousFailureAt === "number" && now - previousFailureAt > failureWindowMs;

    if (expiredCooldown || outsideWindow) {
      usage.errorCount = 0;
      usage.failureCounts = {};
    }

    usage.errorCount = (usage.errorCount ?? 0) + 1;
    usage.lastFailureAt = now;
    const failureCounts = usage.failureCounts ?? {};
    usage.failureCounts = {
      ...failureCounts,
      [reason]: (failureCounts[reason] ?? 0) + 1,
    };

    if (reason === "billing" || reason === "auth_permanent") {
      usage.disabledUntil = now + DEFAULT_BILLING_DISABLE_MS;
      usage.disabledReason = reason;
      usage.cooldownUntil = undefined;
    } else {
      if (!previousCooldownUntil || previousCooldownUntil <= now) {
        usage.cooldownUntil = now + calculateAuthProfileCooldownMs(usage.errorCount);
      }
      usage.disabledUntil = undefined;
      usage.disabledReason = undefined;
    }

    this.upsertProfile({ ...existing, usageStats: usage }, scope);
  }

  resolveApiKey(
    providerId: string,
    params?: {
      scope?: AuthProfileScope;
      authMode?: ModelProviderAuthMode;
      now?: number;
    },
  ): { profileId: string; apiKey: string } | undefined {
    const scope = params?.scope ?? { scopeType: "global" };
    const profiles = this.listProfiles(scope);
    const order = resolveAuthProfileOrder({
      providerId,
      profiles,
      explicitOrder: this.getProviderOrder(providerId, scope),
      lastGoodProfileId: this.getLastGood(providerId, scope),
      now: params?.now,
      authMode: params?.authMode,
    });

    const byId = new Map(profiles.map((profile) => [profile.id, profile] as const));
    for (const profileId of order) {
      const profile = byId.get(profileId);
      if (!profile) {
        continue;
      }
      const apiKey = resolveApiKeyForProfile(profile.credential, params?.now, params?.authMode);
      if (apiKey) {
        return { profileId, apiKey };
      }
    }
    return undefined;
  }

  private profileSecretName(id: string): string {
    return `${PROFILE_PREFIX}${id}`;
  }

  private deserializeRow(row: AuthSecret): AuthProfileRecord | null {
    const payload = this.deserializeJsonRow(row) as StoredPayload | null;
    if (!payload?.id || !payload.credential || typeof payload.credential !== "object") {
      return null;
    }
    return {
      id: payload.id,
      credential: {
        ...payload.credential,
        provider: normalizeProviderIdForAuth(payload.credential.provider),
      } as AuthProfileCredential,
      usageStats: payload.usageStats,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
    };
  }

  private deserializeJsonRow(row: AuthSecret): unknown {
    const masterKey = resolveMasterKey(this.masterKeyEnv);
    try {
      return JSON.parse(decryptSecret(row.value_ciphertext, row.value_nonce, masterKey));
    } catch {
      return null;
    }
  }

  private saveJsonSecret(
    name: string,
    payload: unknown,
    scope: AuthProfileScope,
    createdBy?: string,
  ): void {
    const masterKey = resolveMasterKey(this.masterKeyEnv);
    const { ciphertext, nonce } = encryptSecret(`${JSON.stringify(payload)}\n`, masterKey);
    this.repo.upsert({
      name,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      valueCiphertext: ciphertext,
      valueNonce: nonce,
      createdBy,
    });
  }
}

export function dedupeProfileIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter((id) => id.trim().length > 0)));
}

export function calculateAuthProfileCooldownMs(errorCount: number): number {
  if (errorCount <= 1) {
    return 60_000;
  }
  if (errorCount === 2) {
    return 5 * 60_000;
  }
  if (errorCount === 3) {
    return 25 * 60_000;
  }
  return 60 * 60_000;
}

function resolveUnavailableUntil(
  usageStats: ProfileUsageStats | undefined,
  now: number,
): number | undefined {
  const disabledUntil = usageStats?.disabledUntil;
  if (typeof disabledUntil === "number" && disabledUntil > now) {
    return disabledUntil;
  }
  const cooldownUntil = usageStats?.cooldownUntil;
  if (typeof cooldownUntil === "number" && cooldownUntil > now) {
    return cooldownUntil;
  }
  return undefined;
}

function authModePriority(credential: AuthProfileCredential): number {
  switch (credential.type) {
    case "oauth":
      return 0;
    case "token":
      return 1;
    case "api_key":
    default:
      return 2;
  }
}

function credentialMatchesMode(
  credential: AuthProfileCredential,
  authMode: ModelProviderAuthMode | undefined,
): boolean {
  if (authMode === "token") {
    return credential.type === "token";
  }
  if (authMode === "oauth") {
    return credential.type === "oauth" || credential.type === "token";
  }
  return true;
}

export function resolveApiKeyForProfile(
  credential: AuthProfileCredential,
  now = Date.now(),
  authMode?: ModelProviderAuthMode,
): string | undefined {
  if (!credentialMatchesMode(credential, authMode)) {
    return undefined;
  }
  if (
    (credential.type === "oauth" || credential.type === "token") &&
    credential.expires &&
    credential.expires <= now
  ) {
    return undefined;
  }
  if (credential.type === "oauth") {
    return credential.access.trim() || undefined;
  }
  if (credential.type === "token") {
    return credential.token.trim() || undefined;
  }
  return credential.key.trim() || undefined;
}

export function resolveAuthProfileOrder(params: {
  providerId: string;
  profiles: AuthProfileRecord[];
  explicitOrder?: string[];
  lastGoodProfileId?: string | undefined;
  now?: number;
  authMode?: ModelProviderAuthMode;
}): string[] {
  const normalizedProviderId = normalizeProviderIdForAuth(params.providerId);
  const now = params.now ?? Date.now();
  const eligibleProfiles = params.profiles.filter((profile) => {
    const normalizedProfileProvider = normalizeProviderIdForAuth(profile.credential.provider);
    return (
      normalizedProfileProvider === normalizedProviderId &&
      resolveApiKeyForProfile(profile.credential, now, params.authMode) !== undefined
    );
  });

  const byId = new Map(eligibleProfiles.map((profile) => [profile.id, profile] as const));
  const explicitOrder = dedupeProfileIds(
    (params.explicitOrder ?? []).map((id) => id.trim()).filter((id) => byId.has(id)),
  );

  const remainder = eligibleProfiles
    .map((profile) => profile.id)
    .filter((id) => !explicitOrder.includes(id))
    .toSorted((leftId, rightId) => {
      const left = byId.get(leftId);
      const right = byId.get(rightId);
      if (!left || !right) {
        return leftId.localeCompare(rightId);
      }
      const authPriority = authModePriority(left.credential) - authModePriority(right.credential);
      if (authPriority !== 0) {
        return authPriority;
      }
      const leftLastUsed = left.usageStats?.lastUsed ?? 0;
      const rightLastUsed = right.usageStats?.lastUsed ?? 0;
      if (leftLastUsed !== rightLastUsed) {
        return leftLastUsed - rightLastUsed;
      }
      return left.id.localeCompare(right.id);
    });

  const baseOrder = [...explicitOrder, ...remainder];
  const ready: string[] = [];
  const delayed: Array<{ id: string; unavailableUntil: number }> = [];

  for (const id of baseOrder) {
    const profile = byId.get(id);
    if (!profile) {
      continue;
    }
    const unavailableUntil = resolveUnavailableUntil(profile.usageStats, now);
    if (unavailableUntil) {
      delayed.push({ id, unavailableUntil });
    } else {
      ready.push(id);
    }
  }

  delayed.sort(
    (left, right) =>
      left.unavailableUntil - right.unavailableUntil || left.id.localeCompare(right.id),
  );
  return [...ready, ...delayed.map((entry) => entry.id)];
}
