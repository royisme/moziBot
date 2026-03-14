import type { ProviderFlow } from "./index";

export const qianfanFlow = {
  id: "qianfan",
  label: "Qianfan (Baidu)",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "QIANFAN_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "https://qianfan.baidubce.com/v2",
  knownModels: [],
  defaultModelSuggestions: [],
} satisfies ProviderFlow;
