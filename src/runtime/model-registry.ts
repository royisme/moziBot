import type { MoziConfig } from "../config";
import { listCliBackendModels } from "./cli-backends";
import { ProviderRegistry } from "./provider-registry";
import type { ModelDefinition, ModelRef, ModelSpec, ProviderConfig } from "./types";

export class ModelRegistry {
  private config: MoziConfig;
  private providers: ProviderRegistry;
  private models: Map<string, ModelSpec> = new Map();

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

    // For the openai-codex provider: if gpt-5.3-codex is registered but
    // gpt-5.3-codex-spark is not, synthesize the spark variant automatically.
    // This mirrors the openclaw applyOpenAICodexSparkFallback pattern so users
    // don't need to manually add the spark model to their config.
    this.applyCodexSparkFallback();

    const cliModels = listCliBackendModels(this.config);
    for (const spec of cliModels) {
      this.models.set(this.key(spec.provider, spec.id), spec);
    }
  }

  private applyCodexSparkFallback() {
    const CODEX_PROVIDER = "openai-codex";
    const BASE_MODEL_ID = "gpt-5.3-codex";
    const SPARK_MODEL_ID = "gpt-5.3-codex-spark";

    const sparkKey = this.key(CODEX_PROVIDER, SPARK_MODEL_ID);
    if (this.models.has(sparkKey)) {
      // Spark model is already explicitly configured; nothing to do.
      return;
    }

    const baseKey = this.key(CODEX_PROVIDER, BASE_MODEL_ID);
    const baseSpec = this.models.get(baseKey);
    if (!baseSpec) {
      // Base model not configured; skip synthesizing spark.
      return;
    }

    // Synthesize the spark variant from the base model spec.
    this.models.set(sparkKey, { ...baseSpec, id: SPARK_MODEL_ID });
  }

  private buildSpec(provider: ProviderConfig, model: ModelDefinition): ModelSpec {
    const api = model.api || provider.api || "openai-responses";
    return {
      id: model.id,
      provider: provider.id,
      api,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      headers: { ...provider.headers, ...model.headers },
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
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
    const provider = trimmed.slice(0, idx).trim();
    const model = trimmed.slice(idx + 1).trim();
    if (!provider || !model) {
      return null;
    }
    return { provider, model };
  }

  get(ref: string): ModelSpec | undefined {
    const parsed = this.parseRef(ref);
    if (!parsed) {
      return undefined;
    }
    return this.models.get(this.key(parsed.provider, parsed.model));
  }

  resolve(ref: string): { ref: string; spec: ModelSpec } | undefined {
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

  suggestRefs(ref: string, limit = 5): string[] {
    const parsed = this.parseRef(ref);
    if (!parsed) {
      return this.list()
        .map((spec) => this.key(spec.provider, spec.id))
        .slice(0, limit);
    }

    const providerLower = parsed.provider.toLowerCase();
    const candidates = this.list().filter((spec) => spec.provider.toLowerCase() === providerLower);
    if (candidates.length === 0) {
      return this.list()
        .map((spec) => this.key(spec.provider, spec.id))
        .slice(0, limit);
    }

    return candidates
      .map((spec) => ({
        ref: this.key(spec.provider, spec.id),
        dist: editDistance(parsed.model.toLowerCase(), spec.id.toLowerCase()),
      }))
      .toSorted((a, b) => a.dist - b.dist || a.ref.localeCompare(b.ref))
      .slice(0, limit)
      .map((entry) => entry.ref);
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
