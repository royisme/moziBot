import type { ProviderFlow } from "./index";

export const moonshotFlow = {
  id: "moonshot",
  label: "Moonshot",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "MOONSHOT_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "https://api.moonshot.ai/v1",
  knownModels: [{ id: "kimi-k2.5", label: "Kimi K2.5", api: "openai-completions" }],
  defaultModelSuggestions: [{ alias: "default", modelId: "kimi-k2.5", label: "Kimi K2.5" }],
} satisfies ProviderFlow;
