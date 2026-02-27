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

const MAX_CONTEXT_LENGTH_RETRIES = 4;
const MIN_CONTEXT_RETRY_CHARS = 256;

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
      ...params.headers,
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

function isContextLengthError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("input length exceeds the context length");
}

function truncateBatchByMaxChars(batch: string[], maxChars: number): string[] {
  return batch.map((text) => (text.length > maxChars ? text.slice(0, maxChars) : text));
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
        let currentBatch = batch;
        let payload: unknown;
        for (let attempt = 0; ; attempt += 1) {
          try {
            const body = { model: params.model, input: currentBatch };
            payload = await postEmbeddings({
              url,
              apiKey: params.remote.apiKey,
              headers: params.remote.headers,
              timeoutMs: params.remote.timeoutMs,
              body,
            });
            break;
          } catch (error) {
            if (!isContextLengthError(error) || attempt >= MAX_CONTEXT_LENGTH_RETRIES) {
              throw error;
            }
            const longest = currentBatch.reduce((max, text) => Math.max(max, text.length), 0);
            if (longest <= MIN_CONTEXT_RETRY_CHARS) {
              throw error;
            }
            const nextMaxChars = Math.max(MIN_CONTEXT_RETRY_CHARS, Math.floor(longest / 2));
            const nextBatch = truncateBatchByMaxChars(currentBatch, nextMaxChars);
            const changed = nextBatch.some(
              (text, idx) => text.length !== currentBatch[idx]?.length,
            );
            if (!changed) {
              throw error;
            }
            logger.warn(
              {
                provider: params.id,
                model: params.model,
                attempt: attempt + 1,
                longestChars: longest,
                nextMaxChars,
              },
              "Embedding input exceeded context length; retrying with truncated input",
            );
            currentBatch = nextBatch;
          }
        }
        const parsed = parseEmbeddings(payload, batch.length);
        results.push(...parsed);
      }
      return results;
    },
  };
}
