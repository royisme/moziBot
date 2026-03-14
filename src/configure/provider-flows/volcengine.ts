import type { ProviderFlow } from "./index";

export const volcengineFlow = {
  id: "volcengine",
  label: "Volcengine (Doubao)",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "VOLCANO_ENGINE_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  knownModels: [
    { id: "doubao-seed-1-8-251228", label: "Doubao Seed 1.8", api: "openai-completions" },
    { id: "ark-code-latest", label: "Ark Code Latest", api: "openai-completions" },
  ],
  defaultModelSuggestions: [
    { alias: "default", modelId: "doubao-seed-1-8-251228", label: "Doubao Seed 1.8" },
  ],
} satisfies ProviderFlow;
