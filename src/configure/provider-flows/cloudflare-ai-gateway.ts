import type { ProviderFlow } from "./index";

export const cloudflareAiGatewayFlow = {
  id: "cloudflare-ai-gateway",
  label: "Cloudflare AI Gateway",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "CLOUDFLARE_AI_GATEWAY_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  knownModels: [{ id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", api: "anthropic-messages" }],
  defaultModelSuggestions: [
    { alias: "default", modelId: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  ],
} satisfies ProviderFlow;
