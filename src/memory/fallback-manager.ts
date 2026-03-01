import { logger } from "../logger";
import { expandQueryForFts } from "./query-expansion";
import type {
  MemoryEmbeddingProbeResult,
  MemorySearchManager,
  MemorySearchResult,
  ReadFileParams,
  ReadFileResult,
  SearchOptions,
  SyncParams,
} from "./types";

const LOW_RECALL_MIN_RESULTS = 2;

export class FallbackMemoryManager implements MemorySearchManager {
  private fallback: MemorySearchManager | null = null;
  private primaryFailed = false;
  private lastError?: string;
  private readonly label: string;
  private readonly shouldPreempt?: (status: ReturnType<MemorySearchManager["status"]>) => {
    shouldFallback: boolean;
    reason?: string;
  };

  constructor(
    private readonly deps: {
      primary: MemorySearchManager;
      fallbackFactory: () => Promise<MemorySearchManager | null>;
    },
    options?: {
      label?: string;
      shouldPreempt?: (status: ReturnType<MemorySearchManager["status"]>) => {
        shouldFallback: boolean;
        reason?: string;
      };
    },
    private readonly onClose?: () => void,
  ) {
    this.label = options?.label ?? "primary";
    this.shouldPreempt = options?.shouldPreempt;
  }

  async search(query: string, opts?: SearchOptions): Promise<MemorySearchResult[]> {
    if (!this.primaryFailed && this.shouldPreemptToFallback()) {
      this.primaryFailed = true;
    }
    if (!this.primaryFailed) {
      try {
        const results = await this.deps.primary.search(query, opts);
        if (!this.shouldFallbackOnLowRecall(results, opts)) {
          return results;
        }
        const fallback = await this.ensureFallback();
        if (!fallback) {
          return results;
        }
        const fallbackQuery = this.buildFallbackQuery(query, fallback);
        const fallbackResults = await fallback.search(fallbackQuery, opts);
        return this.mergeResults(results, fallbackResults, opts);
      } catch (err) {
        this.primaryFailed = true;
        this.lastError = err instanceof Error ? err.message : String(err);
        logger.warn(`${this.label} memory failed; switching to builtin: ${this.lastError}`);
        await this.deps.primary.close?.().catch(() => {});
      }
    }

    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.search(query, opts);
    }
    throw new Error(this.lastError ?? "memory search unavailable");
  }

  async readFile(params: ReadFileParams): Promise<ReadFileResult> {
    if (!this.primaryFailed) {
      return await this.deps.primary.readFile(params);
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.readFile(params);
    }
    throw new Error(this.lastError ?? "memory read unavailable");
  }

  status() {
    if (!this.primaryFailed) {
      return this.deps.primary.status();
    }
    const fallbackStatus = this.fallback?.status();
    if (fallbackStatus) {
      return {
        ...fallbackStatus,
        fallback: { from: this.label, reason: this.lastError ?? "unknown" },
      };
    }
    const primaryStatus = this.deps.primary.status();
    return {
      ...primaryStatus,
      fallback: { from: this.label, reason: this.lastError ?? "unknown" },
    };
  }

  async sync(params?: SyncParams): Promise<void> {
    if (!this.primaryFailed) {
      await this.deps.primary.sync?.(params);
      return;
    }
    const fallback = await this.ensureFallback();
    await fallback?.sync?.(params);
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    if (!this.primaryFailed) {
      return await this.deps.primary.probeEmbeddingAvailability();
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.probeEmbeddingAvailability();
    }
    return {
      ok: false,
      error: this.lastError ?? "memory embeddings unavailable",
    };
  }

  async probeVectorAvailability(): Promise<boolean> {
    if (!this.primaryFailed) {
      return await this.deps.primary.probeVectorAvailability();
    }
    const fallback = await this.ensureFallback();
    return (await fallback?.probeVectorAvailability()) ?? false;
  }

  async close(): Promise<void> {
    await this.deps.primary.close?.();
    await this.fallback?.close?.();
    this.onClose?.();
  }

  private async ensureFallback(): Promise<MemorySearchManager | null> {
    if (this.fallback) {
      return this.fallback;
    }
    this.fallback = await this.deps.fallbackFactory();
    return this.fallback;
  }

  private shouldPreemptToFallback(): boolean {
    if (!this.shouldPreempt) {
      return false;
    }
    const status = this.deps.primary.status();
    const result = this.shouldPreempt(status);
    if (!result.shouldFallback) {
      return false;
    }
    this.lastError = result.reason ?? this.lastError ?? `${this.label} unavailable`;
    logger.warn(`${this.label} memory circuit-open; switching to builtin: ${this.lastError}`);
    return true;
  }

  private shouldFallbackOnLowRecall(results: MemorySearchResult[], opts?: SearchOptions): boolean {
    const requested = opts?.maxResults;
    if (requested !== undefined && requested <= 0) {
      return false;
    }
    const minResults =
      requested !== undefined
        ? Math.min(LOW_RECALL_MIN_RESULTS, Math.max(1, requested))
        : LOW_RECALL_MIN_RESULTS;
    return results.length < minResults;
  }

  private buildFallbackQuery(query: string, fallback: MemorySearchManager): string {
    const status = fallback.status();
    const ftsAvailable = Boolean(status.fts?.available);
    if (!ftsAvailable) {
      return query;
    }
    const expanded = expandQueryForFts(query).expanded;
    return expanded || query;
  }

  private mergeResults(
    primary: MemorySearchResult[],
    fallback: MemorySearchResult[],
    opts?: SearchOptions,
  ): MemorySearchResult[] {
    const limit = opts?.maxResults ?? Math.max(primary.length, fallback.length);
    const seen = new Set<string>();
    const merged: MemorySearchResult[] = [];
    const push = (entry: MemorySearchResult) => {
      const key = `${entry.path}:${entry.startLine}:${entry.endLine}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      merged.push(entry);
    };
    for (const entry of primary) {
      push(entry);
      if (limit > 0 && merged.length >= limit) {
        return merged;
      }
    }
    for (const entry of fallback) {
      push(entry);
      if (limit > 0 && merged.length >= limit) {
        break;
      }
    }
    return merged;
  }
}
