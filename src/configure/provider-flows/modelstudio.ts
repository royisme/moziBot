import type { ProviderFlow } from "./index";

export const modelstudioFlow = {
  id: "modelstudio",
  label: "ModelStudio (Qwen)",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "MODELSTUDIO_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
  knownModels: [{ id: "qwen3.5-plus", label: "Qwen 3.5 Plus", api: "openai-completions" }],
  defaultModelSuggestions: [{ alias: "default", modelId: "qwen3.5-plus", label: "Qwen 3.5 Plus" }],
} satisfies ProviderFlow;
