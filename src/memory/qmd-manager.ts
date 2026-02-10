import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MoziConfig } from "../config";
import type { ResolvedMemoryBackendConfig, ResolvedQmdConfig } from "./backend-config";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  ReadFileParams,
  ReadFileResult,
  SearchOptions,
  SyncParams,
} from "./types";
import { logger } from "../logger";
import { resolveHomeDir } from "./backend-config";
import { buildCollectionIndex, ensureCollections } from "./qmd/collections";
import { QmdDocResolver } from "./qmd/doc-resolver";
import { resolveReadPath, type CollectionRoot } from "./qmd/path-utils";
import { runQmd, parseQueryResults } from "./qmd/qmd-client";
import { isScopeAllowed } from "./qmd/scope";
import {
  exportSessions,
  pickSessionCollectionName,
  type SessionExporterConfig,
} from "./qmd/session-exporter";
import { clampResultsByInjectedChars, extractSnippetLines } from "./qmd/snippet";

export class QmdMemoryManager implements MemorySearchManager {
  static async create(params: {
    config: MoziConfig;
    agentId: string;
    resolved: ResolvedMemoryBackendConfig;
  }): Promise<QmdMemoryManager | null> {
    const resolved = params.resolved.qmd;
    if (!resolved) {
      return null;
    }
    const manager = new QmdMemoryManager({
      config: params.config,
      agentId: params.agentId,
      resolved,
    });
    await manager.initialize();
    return manager;
  }

  private readonly config: MoziConfig;
  private readonly agentId: string;
  private readonly qmd: ResolvedQmdConfig;
  private readonly homeDir: string;
  private readonly stateDir: string;
  private readonly agentStateDir: string;
  private readonly qmdDir: string;
  private readonly xdgConfigHome: string;
  private readonly xdgCacheHome: string;
  private readonly indexPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly collectionRoots: Map<string, CollectionRoot>;
  private readonly sources: Set<"memory" | "sessions">;
  private readonly sessionExporter: SessionExporterConfig | null;
  private readonly docResolver: QmdDocResolver;
  private updateTimer: NodeJS.Timeout | null = null;
  private pendingUpdate: Promise<void> | null = null;
  private closed = false;
  private lastUpdateAt: number | null = null;
  private lastEmbedAt: number | null = null;
  private consecutiveUpdateFailures = 0;
  private circuitOpenUntil = 0;
  private lastFailureReason: string | null = null;

  private constructor(params: {
    config: MoziConfig;
    agentId: string;
    resolved: ResolvedQmdConfig;
  }) {
    this.config = params.config;
    this.agentId = params.agentId;
    this.homeDir = resolveHomeDir(params.config, params.agentId);
    this.stateDir = params.config.paths?.baseDir ?? path.join(os.homedir(), ".mozi");
    this.agentStateDir = path.join(this.stateDir, "agents", this.agentId, "qmd");
    this.qmdDir = this.agentStateDir;
    this.xdgConfigHome = path.join(this.qmdDir, "xdg-config");
    this.xdgCacheHome = path.join(this.qmdDir, "xdg-cache");
    this.indexPath = path.join(this.xdgCacheHome, "qmd", "index.sqlite");

    const collections = [...params.resolved.collections];
    this.sessionExporter = params.resolved.sessions.enabled
      ? {
          dir: params.resolved.sessions.exportDir ?? path.join(this.qmdDir, "sessions"),
          retentionMs: params.resolved.sessions.retentionDays
            ? params.resolved.sessions.retentionDays * 24 * 60 * 60 * 1000
            : undefined,
          collectionName: pickSessionCollectionName(
            collections.map((collection) => collection.name),
          ),
        }
      : null;

    if (this.sessionExporter) {
      collections.push({
        name: this.sessionExporter.collectionName,
        path: this.sessionExporter.dir,
        pattern: "**/*.md",
        kind: "sessions",
      });
    }

    this.qmd = { ...params.resolved, collections };

    this.env = {
      ...process.env,
      XDG_CONFIG_HOME: this.xdgConfigHome,
      XDG_CACHE_HOME: this.xdgCacheHome,
      NO_COLOR: "1",
    };

    const { collectionRoots, sources } = buildCollectionIndex(this.qmd.collections);
    this.collectionRoots = collectionRoots;
    this.sources = sources;
    this.docResolver = new QmdDocResolver(
      this.indexPath,
      this.homeDir,
      this.collectionRoots,
      this.sources,
    );
  }

  private async initialize(): Promise<void> {
    await fs.mkdir(this.xdgConfigHome, { recursive: true });
    await fs.mkdir(this.xdgCacheHome, { recursive: true });
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });

    await ensureCollections({
      qmd: this.qmd,
      env: this.env,
      workspaceDir: this.homeDir,
    });

    if (this.qmd.update.onBoot) {
      await this.runUpdate("boot", true);
    }
    if (this.qmd.update.intervalMs > 0) {
      this.updateTimer = setInterval(() => {
        void this.runUpdate("interval").catch((err) => {
          logger.warn(`qmd update failed (${String(err)})`);
        });
      }, this.qmd.update.intervalMs);
    }
  }

  async search(query: string, opts?: SearchOptions): Promise<MemorySearchResult[]> {
    if (!isScopeAllowed(this.qmd.scope, opts?.sessionKey)) {
      return [];
    }
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    await this.pendingUpdate?.catch(() => undefined);
    const limit = Math.min(
      this.qmd.limits.maxResults,
      opts?.maxResults ?? this.qmd.limits.maxResults,
    );
    const args = ["query", trimmed, "--json", "-n", String(limit)];
    let stdout: string;
    try {
      const result = await runQmd({
        command: this.qmd.command,
        args,
        env: this.env,
        cwd: this.homeDir,
        timeoutMs: this.qmd.limits.timeoutMs,
      });
      stdout = result.stdout;
    } catch (err) {
      logger.warn(
        {
          event: "qmd_query_error",
          agentId: this.agentId,
          query: trimmed,
          args,
          error: String(err),
        },
        `qmd query failed: ${String(err)}`,
      );
      throw err instanceof Error ? err : new Error(String(err));
    }

    let parsed;
    try {
      parsed = parseQueryResults(stdout);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        {
          event: "qmd_parse_error",
          agentId: this.agentId,
          query: trimmed,
          stdout: stdout.slice(0, 1000),
          error: message,
        },
        `qmd query returned invalid JSON: ${message}`,
      );
      throw new Error(`qmd query returned invalid JSON: ${message}`, {
        cause: err,
      });
    }

    const results: MemorySearchResult[] = [];
    for (const entry of parsed) {
      const doc = await this.docResolver.resolveDocLocation(entry.docid);
      if (!doc) {
        continue;
      }
      const snippetRaw = entry.snippet ?? entry.body ?? "";
      const snippet = snippetRaw.slice(0, this.qmd.limits.maxSnippetChars);
      const lines = extractSnippetLines(snippet);
      const score = typeof entry.score === "number" ? entry.score : 0;
      const minScore = opts?.minScore ?? 0;
      if (score < minScore) {
        continue;
      }
      results.push({
        path: doc.rel,
        startLine: lines.startLine,
        endLine: lines.endLine,
        score,
        snippet,
        source: doc.source,
      });
    }
    return clampResultsByInjectedChars(results.slice(0, limit), this.qmd.limits.maxInjectedChars);
  }

  async sync(params?: SyncParams): Promise<void> {
    if (params?.progress) {
      params.progress({ completed: 0, total: 1, label: "Updating QMD index…" });
    }
    await this.runUpdate(params?.reason ?? "manual", params?.force);
    if (params?.progress) {
      params.progress({ completed: 1, total: 1, label: "QMD index updated" });
    }
  }

  async readFile(params: ReadFileParams): Promise<ReadFileResult> {
    const relPath = params.relPath?.trim();
    if (!relPath) {
      throw new Error("path required");
    }
    const absPath = resolveReadPath({
      relPath,
      workspaceDir: this.homeDir,
      collectionRoots: this.collectionRoots,
    });
    if (!absPath.endsWith(".md")) {
      throw new Error("only .md files allowed");
    }
    const stat = await fs.lstat(absPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("invalid file type");
    }
    const content = await fs.readFile(absPath, "utf-8");
    if (!params.from && !params.lines) {
      return { text: content, path: relPath };
    }
    const lines = content.split(/\r?\n/);
    const start = Math.max(1, params.from ?? 1);
    const count = Math.max(1, params.lines ?? lines.length);
    const slice = lines.slice(start - 1, start - 1 + count);
    return { text: slice.join("\n"), path: relPath };
  }

  status(): MemoryProviderStatus {
    const counts = this.docResolver.readCounts();
    return {
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      files: counts.totalDocuments,
      chunks: counts.totalDocuments,
      dirty: false,
      workspaceDir: this.homeDir,
      dbPath: this.indexPath,
      sources: Array.from(this.sources),
      sourceCounts: counts.sourceCounts,
      vector: { enabled: true, available: true },
      custom: {
        qmd: {
          collections: this.qmd.collections.length,
          lastUpdateAt: this.lastUpdateAt,
          reliability: {
            consecutiveUpdateFailures: this.consecutiveUpdateFailures,
            circuitOpen: this.isCircuitOpen(),
            circuitOpenUntil: this.circuitOpenUntil || null,
            lastFailureReason: this.lastFailureReason,
          },
        },
      },
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return { ok: true };
  }

  async probeVectorAvailability(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    await this.pendingUpdate?.catch(() => undefined);
    this.docResolver.close();
  }

  private async runUpdate(reason: string, force?: boolean): Promise<void> {
    if (this.pendingUpdate && !force) {
      return this.pendingUpdate;
    }
    if (this.shouldSkipUpdate(force)) {
      return;
    }
    const run = async () => {
      if (this.isCircuitOpen() && !force) {
        logger.warn(
          {
            event: "qmd_update_circuit_open",
            agentId: this.agentId,
            reason,
            circuitOpenUntil: this.circuitOpenUntil,
          },
          `qmd update skipped due to circuit-open (${reason})`,
        );
        return;
      }
      logger.info(
        { event: "qmd_update_start", agentId: this.agentId, reason, force },
        `starting qmd update (${reason})`,
      );
      const startTime = Date.now();
      try {
        if (this.sessionExporter) {
          await exportSessions({
            config: this.config,
            agentId: this.agentId,
            exporter: this.sessionExporter,
          });
        }
        await this.runQmdWithRetry(["update"], reason, force);
        const embedIntervalMs = this.qmd.update.embedIntervalMs;
        const shouldEmbed =
          Boolean(force) ||
          this.lastEmbedAt === null ||
          (embedIntervalMs > 0 && Date.now() - this.lastEmbedAt > embedIntervalMs);
        if (shouldEmbed) {
          try {
            await this.runQmdWithRetry(["embed"], reason, force);
            this.lastEmbedAt = Date.now();
          } catch (err) {
            logger.warn(
              { event: "qmd_embed_error", agentId: this.agentId, reason, error: String(err) },
              `qmd embed failed (${reason}): ${String(err)}`,
            );
          }
        }
        this.consecutiveUpdateFailures = 0;
        this.lastFailureReason = null;
        this.circuitOpenUntil = 0;
        this.lastUpdateAt = Date.now();
        this.docResolver.clearCache();
        const duration = Date.now() - startTime;
        logger.info(
          { event: "qmd_update_end", agentId: this.agentId, reason, duration },
          `qmd update finished in ${duration}ms`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.lastFailureReason = message;
        this.consecutiveUpdateFailures += 1;
        if (this.consecutiveUpdateFailures >= this.qmd.reliability.circuitBreakerThreshold) {
          this.circuitOpenUntil = Date.now() + this.qmd.reliability.circuitOpenMs;
        }
        logger.error(
          {
            event: "qmd_update_error",
            agentId: this.agentId,
            reason,
            error: String(err),
            consecutiveUpdateFailures: this.consecutiveUpdateFailures,
            circuitOpenUntil: this.circuitOpenUntil || undefined,
          },
          `qmd update failed (${reason}): ${String(err)}`,
        );
        throw err;
      }
    };
    this.pendingUpdate = run().finally(() => {
      this.pendingUpdate = null;
    });
    await this.pendingUpdate;
  }

  private shouldSkipUpdate(force?: boolean): boolean {
    if (force) {
      return false;
    }
    const debounceMs = this.qmd.update.debounceMs;
    if (debounceMs <= 0) {
      return false;
    }
    if (!this.lastUpdateAt) {
      return false;
    }
    return Date.now() - this.lastUpdateAt < debounceMs;
  }

  private async runQmdWithRetry(args: string[], reason: string, force?: boolean): Promise<void> {
    const maxRetries = force ? 0 : this.qmd.reliability.maxRetries;
    let attempt = 0;
    for (;;) {
      try {
        await runQmd({
          command: this.qmd.command,
          args,
          env: this.env,
          cwd: this.homeDir,
          timeoutMs: 120_000,
        });
        return;
      } catch (err) {
        if (attempt >= maxRetries) {
          throw err;
        }
        const waitMs = this.qmd.reliability.retryBackoffMs * (attempt + 1);
        logger.warn(
          {
            event: "qmd_retry",
            agentId: this.agentId,
            reason,
            args,
            attempt: attempt + 1,
            waitMs,
            error: String(err),
          },
          `qmd ${args.join(" ")} failed; retrying (${attempt + 1}/${maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        attempt += 1;
      }
    }
  }

  private isCircuitOpen(): boolean {
    return this.circuitOpenUntil > Date.now();
  }
}
