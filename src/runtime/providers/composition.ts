import type { MoziConfig } from "../../config";
import { normalizeProviderId } from "../provider-normalization";
import type {
  ModelDefinition,
  ProviderConfig,
  ProviderContract,
  ProviderTransportKind,
  ResolvedProvider,
} from "../types";
import { getProviderContract } from "./contracts";

function cloneModelDefinition(model: ModelDefinition): ModelDefinition {
  return {
    ...model,
    input: model.input ? [...model.input] : undefined,
    cost: model.cost ? { ...model.cost } : undefined,
    headers: model.headers ? { ...model.headers } : undefined,
    compat: model.compat ? { ...model.compat } : undefined,
  };
}

function mergeModel(base: ModelDefinition | undefined, override: ModelDefinition): ModelDefinition {
  return {
    id: override.id,
    name: override.name,
    api: override.api ?? base?.api,
    reasoning: override.reasoning ?? base?.reasoning,
    input: override.input ?? base?.input,
    cost: { ...base?.cost, ...override.cost },
    contextWindow: override.contextWindow ?? base?.contextWindow,
    maxTokens: override.maxTokens ?? base?.maxTokens,
    headers: { ...base?.headers, ...override.headers },
    compat: { ...base?.compat, ...override.compat },
  };
}

function composeModels(
  contract: ProviderContract | undefined,
  configured: ModelDefinition[],
): ModelDefinition[] {
  const contractById = new Map<string, ModelDefinition>(
    (contract?.catalog ?? []).map((model: ModelDefinition) => [model.id, model]),
  );
  return configured.map((model: ModelDefinition) => mergeModel(contractById.get(model.id), model));
}

function resolveTransportKind(
  id: string,
  entry: NonNullable<NonNullable<MoziConfig["models"]>["providers"]>[string],
  contract: ProviderContract | undefined,
): ProviderTransportKind {
  const explicit = (entry as { transportKind?: ProviderTransportKind }).transportKind;
  if (explicit) {
    return explicit;
  }
  if (contract?.transportKind) {
    return contract.transportKind;
  }
  if ((entry.api ?? "") === "cli-backend") {
    return "cli-backend";
  }
  if (id === "claude-cli" || id === "codex-cli" || id === "google-gemini-cli") {
    return "cli-backend";
  }
  return "openai-compat";
}

export function composeResolvedProvider(
  id: string,
  entry: NonNullable<NonNullable<MoziConfig["models"]>["providers"]>[string],
): ResolvedProvider {
  const normalizedId = normalizeProviderId(id);
  const contract = getProviderContract(normalizedId);
  const configuredModels: ModelDefinition[] = (entry.models ?? []).map((m: ModelDefinition) => ({
    id: m.id,
    name: m.name,
    api: m.api,
    reasoning: m.reasoning,
    input: m.input,
    cost: m.cost,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    headers: m.headers,
    compat: m.compat,
  }));

  return {
    id: normalizedId,
    api: entry.api ?? contract?.canonicalApi,
    auth: entry.auth ?? contract?.auth,
    baseUrl: entry.baseUrl ?? contract?.canonicalBaseUrl,
    apiKey: entry.apiKey,
    injectNumCtxForOpenAICompat: entry.injectNumCtxForOpenAICompat,
    headers: { ...contract?.canonicalHeaders, ...entry.headers },
    authHeader: entry.authHeader,
    models: composeModels(contract, configuredModels).map((model) => cloneModelDefinition(model)),
    transportKind: resolveTransportKind(normalizedId, entry, contract),
  };
}

export function composeResolvedProviders(config: MoziConfig): ResolvedProvider[] {
  const entries = config.models?.providers ?? {};
  return Object.entries(entries).map(([id, entry]) => composeResolvedProvider(id, entry));
}

export type { ProviderConfig };
