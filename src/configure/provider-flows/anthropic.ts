import type { ProviderFlow } from "./index";

export const anthropicFlow = {
  id: "anthropic",
  label: "Anthropic",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "ANTHROPIC_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "https://api.anthropic.com",
  knownModels: [
    {
      id: "claude-sonnet-4-20250514",
      label: "Claude Sonnet 4",
      api: "anthropic-messages",
      reasoning: true,
      input: ["text", "image", "file"],
      contextWindow: 200000,
      maxTokens: 64000,
    },
    {
      id: "claude-haiku-4-5-20251001",
      label: "Claude Haiku 4.5",
      api: "anthropic-messages",
      reasoning: true,
      input: ["text", "image", "file"],
      contextWindow: 200000,
      maxTokens: 64000,
    },
    {
      id: "claude-opus-4-20250514",
      label: "Claude Opus 4",
      api: "anthropic-messages",
      reasoning: true,
      input: ["text", "image", "file"],
      contextWindow: 200000,
      maxTokens: 32000,
    },
    {
      id: "claude-3-5-haiku-latest",
      label: "Claude Haiku 3.5",
      api: "anthropic-messages",
      reasoning: false,
      input: ["text", "image", "file"],
      contextWindow: 200000,
      maxTokens: 8192,
    },
  ],
  defaultModelSuggestions: [
    { alias: "default", modelId: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
    { alias: "fast", modelId: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
} satisfies ProviderFlow;
