import type { ProviderFlow } from "./index";

export const kilocodeFlow = {
  id: "kilocode",
  label: "Kilocode",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "KILOCODE_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "https://api.kilo.ai/api/gateway/",
  knownModels: [{ id: "kilo/auto", label: "Kilo Auto", api: "openai-completions" }],
  defaultModelSuggestions: [{ alias: "default", modelId: "kilo/auto", label: "Kilo Auto" }],
} satisfies ProviderFlow;
