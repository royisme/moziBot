import { logger } from "../../logger";

export type EmbeddingProviderId = "openai" | "ollama";

export type RemoteEmbeddingConfig = {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  batchSize: number;
};

export type EmbeddingProvider = {
  id: EmbeddingProviderId;
  model: string;
  providerKey: string;
  batchSize: number;
  embed: (texts: string[]) => Promise<number[][]>;
};

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function buildEmbeddingsUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  const withSlash = normalized.endsWith("/") ? normalized : `${normalized}/`;
  return new URL("embeddings", withSlash).toString();
}

async function postEmbeddings(params: {
  url: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  body: unknown;
}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(params.headers ?? {}),
    };
    if (params.apiKey) {
      headers.Authorization = `Bearer ${params.apiKey}`;
    }
    const response = await fetch(params.url, {
      method: "POST",
      headers,
      body: JSON.stringify(params.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`embeddings request failed (${response.status}): ${text}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function splitBatches<T>(items: T[], batchSize: number): T[][] {
  if (items.length === 0) {
    return [];
  }
  const size = Math.max(1, Math.floor(batchSize));
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

function parseEmbeddings(payload: unknown, expected: number): number[][] {
  if (!payload || typeof payload !== "object") {
    throw new Error("embeddings response malformed");
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error("embeddings response missing data");
  }
  const embeddings = data
    .map((item) => (item && typeof item === "object" ? (item as { embedding?: unknown }) : null))
    .map((item) => (Array.isArray(item?.embedding) ? item.embedding : []));
  if (embeddings.length !== expected) {
    logger.warn(
      `embeddings response length mismatch (expected ${expected}, got ${embeddings.length})`,
    );
  }
  return embeddings;
}

export function createRemoteEmbeddingProvider(params: {
  id: EmbeddingProviderId;
  model: string;
  remote: RemoteEmbeddingConfig;
}): EmbeddingProvider {
  const baseUrl = normalizeBaseUrl(params.remote.baseUrl);
  const providerKey = baseUrl;
  const url = buildEmbeddingsUrl(baseUrl);
  return {
    id: params.id,
    model: params.model,
    providerKey,
    batchSize: params.remote.batchSize,
    embed: async (texts: string[]) => {
      if (texts.length === 0) {
        return [];
      }
      const batches = splitBatches(texts, params.remote.batchSize);
      const results: number[][] = [];
      for (const batch of batches) {
        const body = { model: params.model, input: batch };
        const payload = await postEmbeddings({
          url,
          apiKey: params.remote.apiKey,
          headers: params.remote.headers,
          timeoutMs: params.remote.timeoutMs,
          body,
        });
        const parsed = parseEmbeddings(payload, batch.length);
        results.push(...parsed);
      }
      return results;
    },
  };
}
