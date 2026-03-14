import type { ProviderFlow } from "./index";

export const xaiFlow = {
  id: "xai",
  label: "xAI",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "XAI_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "https://api.x.ai/v1",
  knownModels: [
    {
      id: "grok-4",
      label: "Grok 4",
      api: "openai-responses",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 8192,
    },
  ],
  defaultModelSuggestions: [{ alias: "default", modelId: "grok-4", label: "Grok 4" }],
} satisfies ProviderFlow;
