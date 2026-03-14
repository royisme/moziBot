import type { ProviderFlow } from "./index";

export const vercelAiGatewayFlow = {
  id: "vercel-ai-gateway",
  label: "Vercel AI Gateway",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "AI_GATEWAY_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "https://ai-gateway.vercel.sh",
  knownModels: [
    { id: "anthropic/claude-opus-4.6", label: "Claude Opus 4.6", api: "openai-completions" },
  ],
  defaultModelSuggestions: [
    { alias: "default", modelId: "anthropic/claude-opus-4.6", label: "Claude Opus 4.6" },
  ],
} satisfies ProviderFlow;
