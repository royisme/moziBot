import type { ProviderFlow } from "./index";

export const opencodeFlow = {
  id: "opencode",
  label: "OpenCode",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "OPENCODE_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "https://opencode.ai/zen/v1",
  knownModels: [{ id: "claude-opus-4-6", label: "Claude Opus 4.6", api: "openai-completions" }],
  defaultModelSuggestions: [
    { alias: "default", modelId: "claude-opus-4-6", label: "Claude Opus 4.6" },
  ],
} satisfies ProviderFlow;
