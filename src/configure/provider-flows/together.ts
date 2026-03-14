import type { ProviderFlow } from "./index";

export const togetherFlow = {
  id: "together",
  label: "Together AI",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "TOGETHER_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "https://api.together.xyz/v1",
  knownModels: [{ id: "moonshotai/Kimi-K2.5", label: "Kimi K2.5", api: "openai-completions" }],
  defaultModelSuggestions: [
    { alias: "default", modelId: "moonshotai/Kimi-K2.5", label: "Kimi K2.5" },
  ],
} satisfies ProviderFlow;
