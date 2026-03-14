import type { ProviderFlow } from "./index";

export const huggingfaceFlow = {
  id: "huggingface",
  label: "Hugging Face",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "HF_TOKEN",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "https://router.huggingface.co/v1",
  knownModels: [{ id: "deepseek-ai/DeepSeek-R1", label: "DeepSeek R1", api: "openai-completions" }],
  defaultModelSuggestions: [
    { alias: "default", modelId: "deepseek-ai/DeepSeek-R1", label: "DeepSeek R1" },
  ],
} satisfies ProviderFlow;
