import type { ProviderFlow } from "./index";

export const openrouterFlow = {
  id: "openrouter",
  label: "OpenRouter",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "OPENROUTER_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "https://openrouter.ai/api/v1",
  knownModels: [
    { id: "openai/gpt-4o-mini", label: "GPT-4o Mini via OpenRouter" },
    { id: "anthropic/claude-3.7-sonnet", label: "Claude 3.7 Sonnet via OpenRouter" },
    { id: "google/gemini-2.0-flash-001", label: "Gemini 2.0 Flash via OpenRouter" },
  ],
  defaultModelSuggestions: [
    { alias: "default", modelId: "anthropic/claude-3.7-sonnet", label: "Claude 3.7 Sonnet" },
    { alias: "fast", modelId: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
  ],
} satisfies ProviderFlow;
