import type { ProviderFlow } from "./index";

export const ollamaFlow = {
  id: "ollama",
  label: "Ollama",
  auth: "none",
  authMethods: ["none"],
  defaultAuthMethod: "none",
  apiEnvVar: "",
  secretSources: [],
  defaultBaseUrl: "http://localhost:11434/v1",
  knownModels: [
    { id: "llama3.2", label: "Llama 3.2", api: "ollama" },
    { id: "qwen2.5-coder", label: "Qwen 2.5 Coder", api: "ollama" },
    { id: "mistral-small", label: "Mistral Small", api: "ollama" },
  ],
  defaultModelSuggestions: [
    { alias: "default", modelId: "llama3.2", label: "Llama 3.2" },
    { alias: "fast", modelId: "qwen2.5-coder", label: "Qwen 2.5 Coder" },
  ],
} satisfies ProviderFlow;
