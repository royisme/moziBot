import type { ModelSpec } from "../types";

const CODEX_PROVIDER = "openai-codex";
const BASE_MODEL_ID = "gpt-5.3-codex";
const SPARK_MODEL_ID = "gpt-5.3-codex-spark";

export function applyCodexSparkFallback(models: Map<string, ModelSpec>): void {
  const sparkKey = `${CODEX_PROVIDER}/${SPARK_MODEL_ID}`;
  if (models.has(sparkKey)) {
    return;
  }

  const baseKey = `${CODEX_PROVIDER}/${BASE_MODEL_ID}`;
  const baseSpec = models.get(baseKey);
  if (!baseSpec) {
    return;
  }

  models.set(sparkKey, { ...baseSpec, id: SPARK_MODEL_ID });
}
