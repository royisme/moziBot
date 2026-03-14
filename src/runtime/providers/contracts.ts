import { PROVIDER_ENV_API_KEY_CANDIDATES } from "../provider-env-vars";
import { normalizeProviderIdForAuth } from "../provider-normalization";
import type { ModelDefinition, ProviderContract } from "../types";

type ProviderContractSeed = Omit<ProviderContract, "apiEnvVar">;

const PROVIDER_CONTRACT_SEEDS: Record<string, ProviderContractSeed> = {
  openai: {
    id: "openai",
    canonicalApi: "openai-responses",
    canonicalBaseUrl: "https://api.openai.com/v1",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [
      {
        id: "gpt-4o",
        name: "GPT-4o",
        api: "openai-responses",
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 128000,
        maxTokens: 16384,
      },
      {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        api: "openai-responses",
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 128000,
        maxTokens: 16384,
      },
      {
        id: "gpt-4.1",
        name: "GPT-4.1",
        api: "openai-responses",
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 1047576,
        maxTokens: 32768,
      },
      {
        id: "gpt-4.1-mini",
        name: "GPT-4.1 Mini",
        api: "openai-responses",
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 1047576,
        maxTokens: 32768,
      },
      {
        id: "o3",
        name: "OpenAI o3",
        api: "openai-responses",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200000,
        maxTokens: 100000,
      },
      {
        id: "o4-mini",
        name: "OpenAI o4-mini",
        api: "openai-responses",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200000,
        maxTokens: 100000,
      },
    ],
  },
  "openai-codex": {
    id: "openai-codex",
    canonicalApi: "openai-codex-responses",
    canonicalBaseUrl: "https://chatgpt.com/backend-api",
    auth: "api-key",
    authModes: ["api-key", "oauth"],
    catalog: [
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", api: "openai-codex-responses" },
      { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", api: "openai-codex-responses" },
      { id: "codex-mini-latest", name: "Codex Mini Latest", api: "openai-codex-responses" },
    ],
  },
  anthropic: {
    id: "anthropic",
    canonicalApi: "anthropic-messages",
    canonicalBaseUrl: "https://api.anthropic.com",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [
      {
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        api: "anthropic-messages",
        reasoning: true,
        input: ["text", "image", "file"],
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: "claude-haiku-4-5-20251001",
        name: "Claude Haiku 4.5",
        api: "anthropic-messages",
        reasoning: true,
        input: ["text", "image", "file"],
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: "claude-opus-4-20250514",
        name: "Claude Opus 4",
        api: "anthropic-messages",
        reasoning: true,
        input: ["text", "image", "file"],
        contextWindow: 200000,
        maxTokens: 32000,
      },
      {
        id: "claude-3-5-haiku-latest",
        name: "Claude Haiku 3.5",
        api: "anthropic-messages",
        reasoning: false,
        input: ["text", "image", "file"],
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  },
  google: {
    id: "google",
    canonicalApi: "google-generative-ai",
    canonicalBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    nativeSdk: true,
    auth: "api-key",
    authModes: ["api-key"],
    transportKind: "native-sdk",
    catalog: [
      {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        api: "google-generative-ai",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
      },
      {
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        api: "google-generative-ai",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
      },
      {
        id: "gemini-2.0-flash",
        name: "Gemini 2.0 Flash",
        api: "google-generative-ai",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 8192,
      },
      {
        id: "gemini-2.0-pro",
        name: "Gemini 2.0 Pro",
        api: "google-generative-ai",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
      },
      {
        id: "gemini-1.5-pro",
        name: "Gemini 1.5 Pro",
        api: "google-generative-ai",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 2097152,
        maxTokens: 8192,
      },
    ],
  },
  openrouter: {
    id: "openrouter",
    canonicalBaseUrl: "https://openrouter.ai/api/v1",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [
      { id: "openai/gpt-4o-mini", name: "GPT-4o Mini via OpenRouter" },
      { id: "anthropic/claude-3.7-sonnet", name: "Claude 3.7 Sonnet via OpenRouter" },
      { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash via OpenRouter" },
    ],
  },
  ollama: {
    id: "ollama",
    canonicalApi: "ollama",
    canonicalBaseUrl: "http://localhost:11434/v1",
    authModes: [],
    catalog: [
      { id: "llama3.2", name: "Llama 3.2", api: "ollama" },
      { id: "qwen2.5-coder", name: "Qwen 2.5 Coder", api: "ollama" },
      { id: "mistral-small", name: "Mistral Small", api: "ollama" },
    ],
  },
  xai: {
    id: "xai",
    canonicalApi: "openai-responses",
    canonicalBaseUrl: "https://api.x.ai/v1",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [
      {
        id: "grok-4",
        name: "Grok 4",
        api: "openai-responses",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 8192,
      },
    ],
  },
  mistral: {
    id: "mistral",
    canonicalApi: "openai-completions",
    canonicalBaseUrl: "https://api.mistral.ai/v1",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [
      {
        id: "mistral-large-latest",
        name: "Mistral Large",
        api: "openai-completions",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 262144,
      },
    ],
  },
  together: {
    id: "together",
    canonicalApi: "openai-completions",
    canonicalBaseUrl: "https://api.together.xyz/v1",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [{ id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5", api: "openai-completions" }],
  },
  huggingface: {
    id: "huggingface",
    canonicalApi: "openai-completions",
    canonicalBaseUrl: "https://router.huggingface.co/v1",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [{ id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1", api: "openai-completions" }],
  },
  minimax: {
    id: "minimax",
    canonicalApi: "openai-completions",
    canonicalBaseUrl: "https://api.minimax.io/v1",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [{ id: "MiniMax-M2.5", name: "MiniMax M2.5", api: "openai-completions" }],
  },
  moonshot: {
    id: "moonshot",
    canonicalApi: "openai-completions",
    canonicalBaseUrl: "https://api.moonshot.ai/v1",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [{ id: "kimi-k2.5", name: "Kimi K2.5", api: "openai-completions" }],
  },
  "kimi-coding": {
    id: "kimi-coding",
    canonicalApi: "openai-completions",
    canonicalBaseUrl: "https://api.kimi.com/coding/",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [{ id: "k2p5", name: "Kimi K2 Plus 5", api: "openai-completions" }],
  },
  volcengine: {
    id: "volcengine",
    canonicalApi: "openai-completions",
    canonicalBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [
      { id: "doubao-seed-1-8-251228", name: "Doubao Seed 1.8", api: "openai-completions" },
      { id: "ark-code-latest", name: "Ark Code Latest", api: "openai-completions" },
    ],
  },
  byteplus: {
    id: "byteplus",
    canonicalApi: "openai-completions",
    canonicalBaseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [
      { id: "seed-1-8-251228", name: "Seed 1.8", api: "openai-completions" },
      { id: "ark-code-latest", name: "Ark Code Latest", api: "openai-completions" },
    ],
  },
  zai: {
    id: "zai",
    canonicalApi: "openai-completions",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [{ id: "glm-5", name: "GLM-5", api: "openai-completions" }],
  },
  xiaomi: {
    id: "xiaomi",
    canonicalApi: "anthropic-messages",
    canonicalBaseUrl: "https://api.xiaomimimo.com/anthropic",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [{ id: "mimo-v2-flash", name: "MiMo v2 Flash", api: "anthropic-messages" }],
  },
  venice: {
    id: "venice",
    canonicalApi: "openai-completions",
    canonicalBaseUrl: "https://api.venice.ai/api/v1",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [{ id: "kimi-k2-5", name: "Kimi K2.5", api: "openai-completions" }],
  },
  synthetic: {
    id: "synthetic",
    canonicalApi: "anthropic-messages",
    canonicalBaseUrl: "https://api.synthetic.new/anthropic",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [{ id: "hf:MiniMaxAI/MiniMax-M2.5", name: "MiniMax M2.5", api: "anthropic-messages" }],
  },
  "cloudflare-ai-gateway": {
    id: "cloudflare-ai-gateway",
    canonicalApi: "anthropic-messages",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", api: "anthropic-messages" }],
  },
  litellm: {
    id: "litellm",
    canonicalApi: "openai-completions",
    canonicalBaseUrl: "http://localhost:4000",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [{ id: "claude-opus-4-6", name: "Claude Opus 4.6", api: "openai-completions" }],
  },
  "vercel-ai-gateway": {
    id: "vercel-ai-gateway",
    canonicalApi: "openai-completions",
    canonicalBaseUrl: "https://ai-gateway.vercel.sh",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [
      { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6", api: "openai-completions" },
    ],
  },
  opencode: {
    id: "opencode",
    canonicalApi: "openai-completions",
    canonicalBaseUrl: "https://opencode.ai/zen/v1",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [{ id: "claude-opus-4-6", name: "Claude Opus 4.6", api: "openai-completions" }],
  },
  qianfan: {
    id: "qianfan",
    canonicalBaseUrl: "https://qianfan.baidubce.com/v2",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [],
  },
  kilocode: {
    id: "kilocode",
    canonicalApi: "openai-completions",
    canonicalBaseUrl: "https://api.kilo.ai/api/gateway/",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [{ id: "kilo/auto", name: "Kilo Auto", api: "openai-completions" }],
  },
  modelstudio: {
    id: "modelstudio",
    canonicalApi: "openai-completions",
    canonicalBaseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
    auth: "api-key",
    authModes: ["api-key"],
    catalog: [{ id: "qwen3.5-plus", name: "Qwen 3.5 Plus", api: "openai-completions" }],
  },
};

const PROVIDER_CONTRACTS = new Map<string, ProviderContract>(
  Object.entries(PROVIDER_CONTRACT_SEEDS).map(([id, seed]) => {
    const authLookupId = normalizeProviderIdForAuth(id);
    const envCandidates =
      PROVIDER_ENV_API_KEY_CANDIDATES[authLookupId] ?? PROVIDER_ENV_API_KEY_CANDIDATES[id] ?? [];
    return [
      id,
      {
        ...seed,
        authModes: [...(seed.authModes ?? [])],
        apiEnvVar: envCandidates[0],
        canonicalHeaders: seed.canonicalHeaders ? { ...seed.canonicalHeaders } : undefined,
        catalog: (seed.catalog ?? []).map((model: ModelDefinition) => cloneModelDefinition(model)),
      },
    ];
  }),
);

function cloneModelDefinition(model: ModelDefinition): ModelDefinition {
  return {
    ...model,
    input: model.input ? [...model.input] : undefined,
    cost: model.cost ? { ...model.cost } : undefined,
    headers: model.headers ? { ...model.headers } : undefined,
    compat: model.compat ? { ...model.compat } : undefined,
  };
}

export function getProviderContract(id: string): ProviderContract | undefined {
  const contract = PROVIDER_CONTRACTS.get(id);
  if (!contract) {
    return undefined;
  }
  return {
    ...contract,
    authModes: contract.authModes ? [...contract.authModes] : undefined,
    canonicalHeaders: contract.canonicalHeaders ? { ...contract.canonicalHeaders } : undefined,
    catalog: contract.catalog?.map((model: ModelDefinition) => cloneModelDefinition(model)),
  };
}

export function listProviderContracts(): ProviderContract[] {
  return Array.from(PROVIDER_CONTRACTS.keys())
    .map((id) => getProviderContract(id))
    .filter((contract): contract is ProviderContract => Boolean(contract));
}

export function findProvidersByEnvVar(envVar: string): string[] {
  const normalized = envVar.trim();
  if (!normalized) {
    return [];
  }
  return listProviderContracts()
    .filter((contract) => contract.apiEnvVar === normalized)
    .map((contract) => contract.id)
    .toSorted((left, right) => left.localeCompare(right));
}
