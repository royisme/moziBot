import type { ProviderFlow } from "./index";

export const mistralFlow = {
  id: "mistral",
  label: "Mistral",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "MISTRAL_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "https://api.mistral.ai/v1",
  knownModels: [
    {
      id: "mistral-large-latest",
      label: "Mistral Large",
      api: "openai-completions",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 262144,
    },
  ],
  defaultModelSuggestions: [
    { alias: "default", modelId: "mistral-large-latest", label: "Mistral Large" },
  ],
} satisfies ProviderFlow;
