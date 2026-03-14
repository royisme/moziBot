import type { ProviderFlow } from "./index";

export const litellmFlow = {
  id: "litellm",
  label: "LiteLLM",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "LITELLM_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "http://localhost:4000",
  knownModels: [{ id: "claude-opus-4-6", label: "Claude Opus 4.6", api: "openai-completions" }],
  defaultModelSuggestions: [
    { alias: "default", modelId: "claude-opus-4-6", label: "Claude Opus 4.6" },
  ],
} satisfies ProviderFlow;
