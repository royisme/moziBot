import { resolveSecretInput } from "../storage/secrets/resolve";
import { AuthProfileStoreAdapter } from "./auth-profiles";
import { readClaudeCliCredentials, readCodexCliCredentials } from "./cli-credentials";
import { PROVIDER_ENV_API_KEY_CANDIDATES } from "./provider-env-vars";
import { normalizeProviderIdForAuth } from "./provider-normalization";
import type { ResolvedProvider } from "./types";

export type ResolveApiKeyForProviderParams = {
  providerId: string;
  provider?: ResolvedProvider;
  env?: NodeJS.ProcessEnv;
  authProfiles?: AuthProfileStoreAdapter;
};

export type ResolvedProviderAuth =
  | { source: "config"; apiKey: string }
  | { source: "env"; apiKey: string }
  | { source: "auth-profile"; apiKey: string; profileId: string }
  | { source: "cli"; apiKey: string }
  | undefined;

function resolveEnvApiKeyForProvider(
  providerId: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const normalizedProviderId = normalizeProviderIdForAuth(providerId);
  const candidates = PROVIDER_ENV_API_KEY_CANDIDATES[normalizedProviderId] ?? [];
  const envKeys = new Set<string>(candidates);

  const configuredEnvVar = PROVIDER_ENV_API_KEY_CANDIDATES[normalizedProviderId]?.[0];
  if (configuredEnvVar) {
    envKeys.add(configuredEnvVar);
  }

  for (const envKey of envKeys) {
    const value = env[envKey];
    if (value?.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

export function resolveProviderAuth({
  providerId,
  provider,
  env = process.env,
  authProfiles,
}: ResolveApiKeyForProviderParams): ResolvedProviderAuth {
  const configuredApiKey = provider?.apiKey;

  if (configuredApiKey !== undefined) {
    const resolvedConfiguredApiKey = resolveSecretInput(configuredApiKey, env);
    if (resolvedConfiguredApiKey) {
      return { source: "config", apiKey: resolvedConfiguredApiKey };
    }
  }

  const envApiKey = resolveEnvApiKeyForProvider(providerId, env);
  if (envApiKey) {
    return { source: "env", apiKey: envApiKey };
  }

  const profileApiKey = authProfiles?.resolveApiKey(providerId, {
    authMode: provider?.auth,
  });
  if (profileApiKey?.apiKey) {
    return {
      source: "auth-profile",
      apiKey: profileApiKey.apiKey,
      profileId: profileApiKey.profileId,
    };
  }

  const normalizedProviderId = normalizeProviderIdForAuth(providerId);
  if (normalizedProviderId === "openai-codex") {
    const apiKey = readCodexCliCredentials()?.access;
    return apiKey ? { source: "cli", apiKey } : undefined;
  }
  if (normalizedProviderId === "anthropic") {
    const credentials = readClaudeCliCredentials();
    const apiKey = credentials?.type === "oauth" ? credentials.access : credentials?.token;
    return apiKey ? { source: "cli", apiKey } : undefined;
  }

  return undefined;
}

export function resolveApiKeyForProvider(
  params: ResolveApiKeyForProviderParams,
): string | undefined {
  return resolveProviderAuth(params)?.apiKey;
}
