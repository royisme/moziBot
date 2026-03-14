import type { ProviderFlow } from "./index";

export const xiaomiFlow = {
  id: "xiaomi",
  label: "Xiaomi MiMo",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "XIAOMI_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "https://api.xiaomimimo.com/anthropic",
  knownModels: [{ id: "mimo-v2-flash", label: "MiMo v2 Flash", api: "anthropic-messages" }],
  defaultModelSuggestions: [{ alias: "default", modelId: "mimo-v2-flash", label: "MiMo v2 Flash" }],
} satisfies ProviderFlow;
