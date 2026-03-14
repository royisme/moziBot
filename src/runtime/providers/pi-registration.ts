import type { Api, StreamFunction } from "@mariozechner/pi-ai";
import { logger } from "../../logger";
import { resolveSecretInput } from "../../storage/secrets/resolve";
import { type AuthProfileStoreAdapter } from "../auth-profiles";
import { resolveProviderAuth } from "../provider-auth";
import type { ModelDefinition, ResolvedProvider } from "../types";

export function normalizePiInputCapabilities(
  input: Array<"text" | "image" | "audio" | "video" | "file"> | undefined,
): Array<"text" | "image"> {
  const supported = input ?? ["text"];
  const normalized = supported.filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  return normalized.length > 0 ? normalized : ["text"];
}

export type PiProviderRegistration = {
  api: Api;
  models: ModelDefinition[];
};

export type PiProviderRegistryLike = {
  registerProvider: (providerId: string, provider: Record<string, unknown>) => void;
};

export function resolvePiProviderRegistration(
  provider: ResolvedProvider,
): PiProviderRegistration | null {
  if (!provider.baseUrl || provider.transportKind !== "openai-compat") {
    return null;
  }

  const models = provider.models ?? [];
  if (models.length === 0) {
    return null;
  }

  const modelApis = [...new Set(models.map((model) => model.api).filter(Boolean))];
  const providerApi = provider.api ?? modelApis[0];
  if (!providerApi) {
    logger.debug({ providerId: provider.id }, "Skipping PI provider registration without API");
    return null;
  }

  const incompatibleModels = models.filter((model) => model.api && model.api !== providerApi);
  if (incompatibleModels.length > 0) {
    logger.warn(
      {
        providerId: provider.id,
        providerApi,
        incompatibleModels: incompatibleModels.map((model) => ({ id: model.id, api: model.api })),
      },
      "Skipping models with API mismatch during PI provider registration",
    );
  }

  const compatibleModels = models.filter((model) => !model.api || model.api === providerApi);
  if (compatibleModels.length === 0) {
    logger.warn(
      { providerId: provider.id, providerApi },
      "Skipping PI provider registration without compatible models",
    );
    return null;
  }

  return {
    api: providerApi,
    models: compatibleModels,
  };
}

export function registerConfiguredPiProviders(params: {
  registry: PiProviderRegistryLike;
  providers: ResolvedProvider[];
  authProfiles: AuthProfileStoreAdapter;
  createCodexDefaultTransportWrapper: (
    baseStreamFn?: StreamFunction,
    params?: {
      authProfiles?: AuthProfileStoreAdapter;
      profileId?: string;
    },
  ) => StreamFunction;
}): void {
  const { registry, providers, authProfiles, createCodexDefaultTransportWrapper } = params;
  for (const provider of providers) {
    const registration = resolvePiProviderRegistration(provider);
    if (!registration || !provider.baseUrl) {
      continue;
    }

    const resolvedProviderAuth = resolveProviderAuth({
      providerId: provider.id,
      provider,
      authProfiles,
    });
    const resolvedApiKey = resolvedProviderAuth?.apiKey;
    const resolvedProviderHeaders = Object.fromEntries(
      Object.entries(provider.headers ?? {}).flatMap(([key, value]) => {
        const resolved = resolveSecretInput(String(value), process.env);
        return resolved ? [[key, resolved] as const] : [];
      }),
    );
    registry.registerProvider(provider.id, {
      api: registration.api,
      baseUrl: provider.baseUrl,
      apiKey: resolvedApiKey,
      headers: resolvedProviderHeaders,
      ...(registration.api === "openai-codex-responses"
        ? {
            streamSimple: createCodexDefaultTransportWrapper(undefined, {
              authProfiles:
                resolvedProviderAuth?.source === "auth-profile" ? authProfiles : undefined,
              profileId:
                resolvedProviderAuth?.source === "auth-profile"
                  ? resolvedProviderAuth.profileId
                  : undefined,
            }),
          }
        : {}),
      models: registration.models.map((model: ModelDefinition) => ({
        id: model.id,
        name: model.name ?? model.id,
        api: model.api ?? registration.api,
        reasoning: model.reasoning ?? false,
        input: normalizePiInputCapabilities(model.input),
        contextWindow: model.contextWindow ?? 128000,
        maxTokens: model.maxTokens ?? 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        headers: { ...resolvedProviderHeaders, ...model.headers },
      })),
    });
  }
}
