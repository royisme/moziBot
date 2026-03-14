import type { ProviderFlow } from "./index";

export const veniceFlow = {
  id: "venice",
  label: "Venice AI",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "VENICE_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "https://api.venice.ai/api/v1",
  knownModels: [{ id: "kimi-k2-5", label: "Kimi K2.5", api: "openai-completions" }],
  defaultModelSuggestions: [{ alias: "default", modelId: "kimi-k2-5", label: "Kimi K2.5" }],
} satisfies ProviderFlow;
