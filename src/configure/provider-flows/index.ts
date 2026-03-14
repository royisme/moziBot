import { getProviderContract, listProviderContracts } from "../../runtime/providers/contracts";
import type {
  ModelApi,
  ModelDefinition,
  ProviderContract as RuntimeProviderContract,
} from "../../runtime/types";
import { anthropicFlow } from "./anthropic";
import { byteplusFlow } from "./byteplus";
import { cloudflareAiGatewayFlow } from "./cloudflare-ai-gateway";
import { googleFlow } from "./google";
import { huggingfaceFlow } from "./huggingface";
import { kilocodeFlow } from "./kilocode";
import { kimiCodingFlow } from "./kimi-coding";
import { litellmFlow } from "./litellm";
import { minimaxFlow } from "./minimax";
import { mistralFlow } from "./mistral";
import { modelstudioFlow } from "./modelstudio";
import { moonshotFlow } from "./moonshot";
import { ollamaFlow } from "./ollama";
import { openaiFlow } from "./openai";
import { opencodeFlow } from "./opencode";
import { openrouterFlow } from "./openrouter";
import { qianfanFlow } from "./qianfan";
import { syntheticFlow } from "./synthetic";
import { togetherFlow } from "./together";
import { veniceFlow } from "./venice";
import { vercelAiGatewayFlow } from "./vercel-ai-gateway";
import { volcengineFlow } from "./volcengine";
import { xaiFlow } from "./xai";
import { xiaomiFlow } from "./xiaomi";
import { zaiFlow } from "./zai";

export type ProviderAuth = "api-key" | "aws-sdk" | "oauth" | "token" | "none";
export type SecretSourceCapability = "shared-storage" | "direct-config" | "external-env";

export interface KnownProviderModel {
  id: string;
  label?: string;
  api?: ModelApi;
  description?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image" | "audio" | "video" | "file">;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  maxTokens?: number;
}

export interface ProviderModelSuggestion {
  alias: string;
  modelId: string;
  label?: string;
}

export interface ProviderFlow {
  id: string;
  label: string;
  auth: ProviderAuth;
  authMethods: readonly ProviderAuth[];
  defaultAuthMethod: ProviderAuth;
  apiEnvVar: string;
  secretSources: readonly SecretSourceCapability[];
  defaultApi?: string;
  defaultBaseUrl?: string;
  defaultHeaders?: Readonly<Record<string, string>>;
  knownModels?: readonly KnownProviderModel[];
  defaultModelSuggestions?: readonly ProviderModelSuggestion[];
}

function toKnownProviderModel(model: ModelDefinition): KnownProviderModel {
  return {
    id: model.id,
    label: model.name,
    api: model.api,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function toProviderAuthModes(contract?: RuntimeProviderContract): {
  auth: ProviderAuth;
  authMethods: readonly ProviderAuth[];
  defaultAuthMethod: ProviderAuth;
} {
  const authModes = contract?.authModes ?? [];
  if (authModes.length === 0) {
    return { auth: "none", authMethods: ["none"], defaultAuthMethod: "none" };
  }
  const auth = contract?.auth ?? authModes[0] ?? "none";
  return {
    auth,
    authMethods: authModes,
    defaultAuthMethod: auth,
  };
}

function overlayRuntimeContract(baseFlow: ProviderFlow): ProviderFlow {
  const contract = getProviderContract(baseFlow.id);
  const authData = toProviderAuthModes(contract);
  return {
    ...baseFlow,
    auth: authData.auth,
    authMethods: authData.authMethods,
    defaultAuthMethod: authData.defaultAuthMethod,
    apiEnvVar: contract?.apiEnvVar ?? baseFlow.apiEnvVar,
    defaultApi: contract?.canonicalApi ?? baseFlow.defaultApi,
    defaultBaseUrl: contract?.canonicalBaseUrl ?? baseFlow.defaultBaseUrl,
    defaultHeaders: contract?.canonicalHeaders ?? baseFlow.defaultHeaders,
    knownModels: contract?.catalog?.map(toKnownProviderModel) ?? baseFlow.knownModels,
  };
}

export function getDefaultProviderApi(flow: ProviderFlow): string | undefined {
  if (flow.defaultApi) {
    return flow.defaultApi;
  }
  const apis = Array.from(
    new Set(flow.knownModels?.flatMap((model) => (model.api ? [model.api] : [])) ?? []),
  );
  return apis.length === 1 ? apis[0] : undefined;
}

const openaiCodexFlow = {
  id: "openai-codex",
  label: "OpenAI Codex",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "OPENAI_CODEX_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "https://chatgpt.com/backend-api",
  knownModels: [
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", api: "openai-codex-responses" },
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", api: "openai-codex-responses" },
    { id: "codex-mini-latest", label: "Codex Mini Latest", api: "openai-codex-responses" },
  ],
  defaultModelSuggestions: [
    { alias: "default", modelId: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { alias: "fast", modelId: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
  ],
} satisfies ProviderFlow;

const BASE_PROVIDER_FLOWS = [
  openaiFlow,
  openaiCodexFlow,
  anthropicFlow,
  googleFlow,
  openrouterFlow,
  ollamaFlow,
  xaiFlow,
  mistralFlow,
  togetherFlow,
  huggingfaceFlow,
  minimaxFlow,
  moonshotFlow,
  kimiCodingFlow,
  volcengineFlow,
  byteplusFlow,
  zaiFlow,
  xiaomiFlow,
  veniceFlow,
  syntheticFlow,
  cloudflareAiGatewayFlow,
  litellmFlow,
  vercelAiGatewayFlow,
  opencodeFlow,
  qianfanFlow,
  kilocodeFlow,
  modelstudioFlow,
] satisfies readonly ProviderFlow[];

export const PROVIDER_FLOWS = BASE_PROVIDER_FLOWS.map(
  overlayRuntimeContract,
) satisfies readonly ProviderFlow[];

export function getProviderFlow(providerId: string): ProviderFlow | undefined {
  return PROVIDER_FLOWS.find((flow) => flow.id === providerId);
}

export function listStandardProviderTargets(): ProviderFlow[] {
  const contractIds = new Set(
    listProviderContracts()
      .filter(
        (contract) => (contract.authModes?.length ?? 0) > 0 && Boolean(contract.apiEnvVar?.trim()),
      )
      .map((contract) => contract.id),
  );
  return PROVIDER_FLOWS.filter((flow) => contractIds.has(flow.id));
}

export function supportsSecretStorage(flow: ProviderFlow): boolean {
  return flow.secretSources.includes("shared-storage");
}

export function supportsDirectConfig(flow: ProviderFlow): boolean {
  return flow.secretSources.includes("direct-config");
}

export function supportsExternalEnv(flow: ProviderFlow): boolean {
  return flow.secretSources.includes("external-env");
}
