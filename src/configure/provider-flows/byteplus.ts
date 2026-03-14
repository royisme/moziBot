import type { ProviderFlow } from "./index";

export const byteplusFlow = {
  id: "byteplus",
  label: "BytePlus",
  auth: "api-key",
  authMethods: ["api-key"],
  defaultAuthMethod: "api-key",
  apiEnvVar: "BYTEPLUS_API_KEY",
  secretSources: ["shared-storage", "direct-config", "external-env"],
  defaultBaseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3",
  knownModels: [
    { id: "seed-1-8-251228", label: "Seed 1.8", api: "openai-completions" },
    { id: "ark-code-latest", label: "Ark Code Latest", api: "openai-completions" },
  ],
  defaultModelSuggestions: [{ alias: "default", modelId: "seed-1-8-251228", label: "Seed 1.8" }],
} satisfies ProviderFlow;
