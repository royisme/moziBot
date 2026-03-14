import type { ProviderFlow } from "./index";

export const kimiCodingFlow = {
  id: "kimi-coding",
  label: "Kimi Coding",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "KIMI_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "https://api.kimi.com/coding/",
  knownModels: [{ id: "k2p5", label: "Kimi K2 Plus 5", api: "openai-completions" }],
  defaultModelSuggestions: [{ alias: "default", modelId: "k2p5", label: "Kimi K2 Plus 5" }],
} satisfies ProviderFlow;
