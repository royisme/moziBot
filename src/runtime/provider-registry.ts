import type { MoziConfig } from "../config";
import { resolveApiKeyForProvider } from "./provider-auth";
import { normalizeProviderId } from "./provider-normalization";
import { composeProvider } from "./providers/contracts";
import type { ProviderConfig } from "./types";

export class ProviderRegistry {
  private providers: Map<string, ProviderConfig> = new Map();

  constructor(config: MoziConfig) {
    const entries = config.models?.providers ?? {};
    for (const [id, entry] of Object.entries(entries)) {
      const normalizedId = normalizeProviderId(id);
      this.providers.set(normalizedId, composeProvider(normalizedId, entry));
    }
  }

  get(id: string): ProviderConfig | undefined {
    return this.providers.get(normalizeProviderId(id));
  }

  list(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  /**
   * Resolve the API key for a provider. Delegates to the standalone auth
   * resolver so provider auth lookup logic stays centralized.
   */
  resolveApiKey(id: string): string | undefined {
    return resolveApiKeyForProvider({
      providerId: normalizeProviderId(id),
      provider: this.providers.get(normalizeProviderId(id)),
    });
  }
}
