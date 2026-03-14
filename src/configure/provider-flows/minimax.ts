import type { ProviderFlow } from "./index";

export const minimaxFlow = {
  id: "minimax",
  label: "MiniMax",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "MINIMAX_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "https://api.minimax.io/v1",
  knownModels: [{ id: "MiniMax-M2.5", label: "MiniMax M2.5", api: "openai-completions" }],
  defaultModelSuggestions: [{ alias: "default", modelId: "MiniMax-M2.5", label: "MiniMax M2.5" }],
} satisfies ProviderFlow;
