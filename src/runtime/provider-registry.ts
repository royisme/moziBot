import type { MoziConfig } from "../config";
import type { ModelDefinition, ProviderConfig } from "./types";

const ENV_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
};

export class ProviderRegistry {
  private providers: Map<string, ProviderConfig> = new Map();

  constructor(config: MoziConfig) {
    const entries = config.models?.providers ?? {};
    for (const [id, entry] of Object.entries(entries)) {
      const models: ModelDefinition[] = (entry.models ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        api: m.api,
        reasoning: m.reasoning,
        input: m.input,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        headers: m.headers,
      }));
      this.providers.set(id, {
        id,
        api: entry.api,
        baseUrl: entry.baseUrl,
        apiKey: entry.apiKey,
        headers: entry.headers,
        models,
      });
    }
  }

  get(id: string): ProviderConfig | undefined {
    return this.providers.get(id);
  }

  list(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  resolveApiKey(id: string): string | undefined {
    const provider = this.providers.get(id);
    if (provider?.apiKey) {
      return provider.apiKey;
    }
    const envKey = ENV_MAP[id];
    if (!envKey) {
      return undefined;
    }
    const value = process.env[envKey];
    return value && value.trim() ? value.trim() : undefined;
  }
}
