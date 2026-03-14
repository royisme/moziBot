import type { ProviderFlow } from "./index";

export const syntheticFlow = {
  id: "synthetic",
  label: "Synthetic",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "SYNTHETIC_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "https://api.synthetic.new/anthropic",
  knownModels: [
    { id: "hf:MiniMaxAI/MiniMax-M2.5", label: "MiniMax M2.5", api: "anthropic-messages" },
  ],
  defaultModelSuggestions: [
    { alias: "default", modelId: "hf:MiniMaxAI/MiniMax-M2.5", label: "MiniMax M2.5" },
  ],
} satisfies ProviderFlow;
