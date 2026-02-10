import type {
  MemoryEmbeddingProbeResult,
  MemorySearchManager,
  MemorySearchResult,
  ReadFileParams,
  ReadFileResult,
  SearchOptions,
  SyncParams,
} from "./types";
import { logger } from "../logger";

export class FallbackMemoryManager implements MemorySearchManager {
  private fallback: MemorySearchManager | null = null;
  private primaryFailed = false;
  private lastError?: string;

  constructor(
    private readonly deps: {
      primary: MemorySearchManager;
      fallbackFactory: () => Promise<MemorySearchManager | null>;
    },
    private readonly onClose?: () => void,
  ) {}

  async search(query: string, opts?: SearchOptions): Promise<MemorySearchResult[]> {
    if (!this.primaryFailed && this.shouldPreemptToFallback()) {
      this.primaryFailed = true;
    }
    if (!this.primaryFailed) {
      try {
        return await this.deps.primary.search(query, opts);
      } catch (err) {
        this.primaryFailed = true;
        this.lastError = err instanceof Error ? err.message : String(err);
        logger.warn(`qmd memory failed; switching to builtin: ${this.lastError}`);
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
        fallback: { from: "qmd", reason: this.lastError ?? "unknown" },
      };
    }
    const primaryStatus = this.deps.primary.status();
    return {
      ...primaryStatus,
      fallback: { from: "qmd", reason: this.lastError ?? "unknown" },
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
    const status = this.deps.primary.status();
    const qmd = (status.custom?.qmd ?? {}) as {
      reliability?: { circuitOpen?: boolean; lastFailureReason?: string | null };
    };
    if (!qmd.reliability?.circuitOpen) {
      return false;
    }
    this.lastError = qmd.reliability.lastFailureReason ?? this.lastError ?? "qmd circuit open";
    logger.warn(`qmd memory circuit-open; switching to builtin: ${this.lastError}`);
    return true;
  }
}
