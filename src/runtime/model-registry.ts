import type { MoziConfig } from "../config";
import { resolveSecretInput } from "../storage/secrets/resolve";
import { listCliBackendModels } from "./cli-backends";
import { normalizeProviderId } from "./provider-normalization";
import { ProviderRegistry } from "./provider-registry";
import { applyCodexSparkFallback } from "./providers/compatibility";
import type { ModelDefinition, ModelRef, ModelSpec, ResolvedProvider } from "./types";

export class ModelRegistry {
  private config: MoziConfig;
  private providers: ProviderRegistry;
  private models: Map<string, ModelSpec> = new Map();
  private aliases: Map<string, string> = new Map();

  constructor(config: MoziConfig) {
    this.config = config;
    this.providers = new ProviderRegistry(config);
    this.buildIndex();
  }

  private buildIndex() {
    for (const provider of this.providers.list()) {
      const models = provider.models ?? [];
      for (const model of models) {
        const spec = this.buildSpec(provider, model);
        this.models.set(this.key(spec.provider, spec.id), spec);
      }
    }

    // Explicit compatibility adapter for OpenClaw-aligned Codex behavior.
    applyCodexSparkFallback(this.models);

    const cliModels = listCliBackendModels(this.config);
    for (const spec of cliModels) {
      this.models.set(this.key(spec.provider, spec.id), spec);
    }

    this.buildAliasIndex();
  }

  private buildAliasIndex() {
    this.aliases.clear();
    const aliases = this.config.models?.aliases;
    if (!aliases) {
      return;
    }
    for (const [alias, modelRef] of Object.entries(aliases)) {
      const normalizedAlias = alias.trim().toLowerCase();
      const normalizedRef = modelRef.trim();
      if (!normalizedAlias || !normalizedRef) {
        continue;
      }
      this.aliases.set(normalizedAlias, normalizedRef);
    }
  }

  private buildSpec(provider: ResolvedProvider, model: ModelDefinition): ModelSpec {
    const api = model.api || provider.api || "openai-responses";
    const resolvedProviderHeaders = Object.fromEntries(
      Object.entries(provider.headers ?? {}).flatMap(([key, value]) => {
        const resolved = resolveSecretInput(value, process.env);
        return resolved ? [[key, resolved] as const] : [];
      }),
    );
    return {
      id: model.id,
      provider: provider.id,
      api,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      headers: { ...resolvedProviderHeaders, ...model.headers },
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      compat: model.compat,
    };
  }

  private key(provider: string, model: string): string {
    return `${provider}/${model}`;
  }

  parseRef(ref: string): ModelRef | null {
    const trimmed = ref.trim();
    if (!trimmed) {
      return null;
    }
    const idx = trimmed.indexOf("/");
    if (idx === -1) {
      return null;
    }
    const provider = normalizeProviderId(trimmed.slice(0, idx));
    const model = trimmed.slice(idx + 1).trim();
    if (!provider || !model) {
      return null;
    }
    return { provider, model };
  }

  private resolveAliasRef(input: string): string | undefined {
    const key = input.trim().toLowerCase();
    if (!key) {
      return undefined;
    }
    return this.aliases.get(key);
  }

  private resolveCanonical(ref: string): { ref: string; spec: ModelSpec } | undefined {
    const parsed = this.parseRef(ref);
    if (!parsed) {
      return undefined;
    }

    const exactRef = this.key(parsed.provider, parsed.model);
    const exact = this.models.get(exactRef);
    if (exact) {
      return { ref: exactRef, spec: exact };
    }

    const providerLower = parsed.provider.toLowerCase();
    const modelLower = parsed.model.toLowerCase();
    for (const spec of this.models.values()) {
      if (spec.provider.toLowerCase() === providerLower && spec.id.toLowerCase() === modelLower) {
        return { ref: this.key(spec.provider, spec.id), spec };
      }
    }

    const fuzzy = this.findClosestWithinProvider(parsed.provider, parsed.model);
    if (fuzzy) {
      return { ref: this.key(fuzzy.provider, fuzzy.id), spec: fuzzy };
    }

    return undefined;
  }

  get(ref: string): ModelSpec | undefined {
    const parsed = this.parseRef(ref);
    if (parsed) {
      const exact = this.models.get(this.key(parsed.provider, parsed.model));
      if (exact) {
        return exact;
      }
    }

    const aliasRef = this.resolveAliasRef(ref);
    if (!aliasRef) {
      return undefined;
    }
    const parsedAlias = this.parseRef(aliasRef);
    if (!parsedAlias) {
      return undefined;
    }
    return this.models.get(this.key(parsedAlias.provider, parsedAlias.model));
  }

  resolve(ref: string): { ref: string; spec: ModelSpec } | undefined {
    const canonical = this.resolveCanonical(ref);
    if (canonical) {
      return canonical;
    }
    const aliasRef = this.resolveAliasRef(ref);
    if (!aliasRef) {
      return undefined;
    }
    return this.resolveCanonical(aliasRef);
  }

  suggestRefs(ref: string, limit = 5): string[] {
    const aliasSuggestions = this.getAliasSuggestions(ref);

    const parsed = this.parseRef(ref);
    if (!parsed) {
      const suggestions = [...aliasSuggestions];
      for (const modelRef of this.list()
        .map((spec) => this.key(spec.provider, spec.id))
        .toSorted()) {
        if (suggestions.includes(modelRef)) {
          continue;
        }
        suggestions.push(modelRef);
        if (suggestions.length >= limit) {
          break;
        }
      }
      return suggestions.slice(0, limit);
    }

    const providerLower = parsed.provider.toLowerCase();
    const candidates = this.list().filter((spec) => spec.provider.toLowerCase() === providerLower);
    const rankedCandidates = candidates.length === 0 ? this.list() : candidates;

    const rankedSuggestions = rankedCandidates
      .map((spec) => ({
        ref: this.key(spec.provider, spec.id),
        dist: editDistance(parsed.model.toLowerCase(), spec.id.toLowerCase()),
      }))
      .toSorted((a, b) => a.dist - b.dist || a.ref.localeCompare(b.ref))
      .map((entry) => entry.ref);

    const merged = [...aliasSuggestions, ...rankedSuggestions];
    return Array.from(new Set(merged)).slice(0, limit);
  }

  private getAliasSuggestions(ref: string): string[] {
    const query = ref.trim().toLowerCase();
    if (!query) {
      return [];
    }

    const ranked = Array.from(this.aliases.entries())
      .map(([alias, modelRef]) => {
        const resolved = this.resolveCanonical(modelRef);
        if (!resolved) {
          return null;
        }
        return {
          ref: resolved.ref,
          dist: editDistance(query, alias),
          alias,
        };
      })
      .filter((entry): entry is { ref: string; dist: number; alias: string } => entry !== null)
      .toSorted(
        (a, b) => a.dist - b.dist || a.alias.localeCompare(b.alias) || a.ref.localeCompare(b.ref),
      );

    return Array.from(new Set(ranked.map((entry) => entry.ref)));
  }

  private findClosestWithinProvider(provider: string, model: string): ModelSpec | undefined {
    const providerLower = provider.toLowerCase();
    const modelLower = model.toLowerCase();
    const candidates = this.list().filter((spec) => spec.provider.toLowerCase() === providerLower);
    if (candidates.length === 0) {
      return undefined;
    }

    const ranked = candidates
      .map((spec) => ({
        spec,
        dist: editDistance(modelLower, spec.id.toLowerCase()),
      }))
      .toSorted((a, b) => a.dist - b.dist || a.spec.id.localeCompare(b.spec.id));

    if (ranked[0] && ranked[0].dist <= 3) {
      return ranked[0].spec;
    }
    return undefined;
  }

  list(): ModelSpec[] {
    return Array.from(this.models.values());
  }
}

function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (!a) {
    return b.length;
  }
  if (!b) {
    return a.length;
  }

  const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = dp[0] ?? 0;
    dp[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = dp[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min((dp[j] ?? 0) + 1, (dp[j - 1] ?? 0) + 1, prev + cost);
      prev = temp;
    }
  }
  return dp[b.length] ?? 0;
}
