import type { ProviderFlow } from "./index";

export const zaiFlow = {
  id: "zai",
  label: "ZAI (Zhipu)",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "ZAI_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  knownModels: [{ id: "glm-5", label: "GLM-5", api: "openai-completions" }],
  defaultModelSuggestions: [{ alias: "default", modelId: "glm-5", label: "GLM-5" }],
} satisfies ProviderFlow;
