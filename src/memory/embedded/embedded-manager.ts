import Database, { type Database as DatabaseType } from "better-sqlite3";
import chokidar, { type FSWatcher } from "chokidar";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MoziConfig } from "../../config";
import type { ResolvedEmbeddedConfig, ResolvedMemoryBackendConfig } from "../backend-config";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  ReadFileParams,
  ReadFileResult,
  SearchOptions,
  SyncParams,
} from "../types";
import { logger } from "../../logger";
import { applyRecallPostProcessing } from "../recall";
import { onSessionTranscriptUpdate } from "../session-transcript-events";
import {
  buildFileEntry,
  chunkMarkdown,
  ensureDir,
  hashText,
  isMemoryPath,
  listMemoryFiles,
  remapChunkLines,
} from "./internal";
import { createRemoteEmbeddingProvider, type EmbeddingProvider } from "./embedding-provider";
import { ensureEmbeddedSchema, loadSqliteVecExtension } from "./schema";
import { buildSessionEntry, listSessionFiles, sessionPathForFile } from "./session-files";
import {
  bm25RankToScore,
  buildFtsQuery,
  mergeHybridResults,
  searchKeyword,
  searchVector,
} from "./search";

const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const DEFAULT_SNIPPET_MAX_CHARS = 700;
const DEFAULT_MIN_SCORE = 0.3;

type EmbeddedMeta = {
  provider?: string;
  providerKey?: string;
  model?: string;
  vectorDims?: number;
};

type EmbeddedManagerParams = {
  agentId: string;
  workspaceDir: string;
  sessionsDir: string;
  settings: ResolvedEmbeddedConfig;
  provider: EmbeddingProvider;
};

export class EmbeddedMemoryManager implements MemorySearchManager {
  static async create(params: {
    config: MoziConfig;
    agentId: string;
    resolved: ResolvedMemoryBackendConfig;
    providerFactory?: (settings: ResolvedEmbeddedConfig) => Promise<EmbeddingProvider>;
  }): Promise<EmbeddedMemoryManager | null> {
    const embedded = params.resolved.embedded;
    if (!embedded || !embedded.enabled) {
      return null;
    }
    try {
      const provider =
        (await params.providerFactory?.(embedded)) ??
        createRemoteEmbeddingProvider({
          id: embedded.provider,
          model: embedded.model,
          remote: embedded.remote,
        });
      const workspaceDir = resolveHomeDir(params.config, params.agentId);
      const sessionsDir = resolveSessionsDir(params.config);
      return new EmbeddedMemoryManager({
        agentId: params.agentId,
        workspaceDir,
        sessionsDir,
        settings: embedded,
        provider,
      });
    } catch (err) {
      logger.warn(`Failed to create embedded memory manager: ${String(err)}`);
      return null;
    }
  }

  private readonly agentId: string;
  private readonly workspaceDir: string;
  private readonly sessionsDir: string;
  private readonly settings: ResolvedEmbeddedConfig;
  private readonly provider: EmbeddingProvider;
  private readonly providerKey: string;
  private readonly db: DatabaseType;
  private readonly sources: Set<MemorySource>;
  private readonly fts: { enabled: boolean; available: boolean; error?: string };
  private readonly vector: {
    enabled: boolean;
    available: boolean | null;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  private dirty = true;
  private sessionsDirty = false;
  private syncing: Promise<void> | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private sessionUnsubscribe: (() => void) | null = null;
  private sessionSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionsDirtyFiles = new Set<string>();
  private fileCounts = new Map<MemorySource, number>();
  private chunkCounts = new Map<MemorySource, number>();
  private vectorReady: Promise<boolean> | null = null;

  private constructor(params: EmbeddedManagerParams) {
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;
    this.sessionsDir = params.sessionsDir;
    this.settings = params.settings;
    this.provider = params.provider;
    this.providerKey = params.provider.providerKey;
    this.sources = new Set(params.settings.sources);
    this.db = this.openDatabase();
    this.fts = { enabled: params.settings.query.hybrid.enabled, available: false };
    const schema = ensureEmbeddedSchema({
      db: this.db,
      embeddingCacheTable: EMBEDDING_CACHE_TABLE,
      ftsTable: FTS_TABLE,
      ftsEnabled: this.fts.enabled,
    });
    this.fts.available = schema.ftsAvailable;
    this.fts.error = schema.ftsError;
    this.vector = {
      enabled: params.settings.store.vector.enabled,
      available: null,
      extensionPath: params.settings.store.vector.extensionPath,
    };
    const meta = this.readMeta();
    if (meta?.vectorDims) {
      this.vector.dims = meta.vectorDims;
    }
    this.ensureWatcher();
    this.ensureSessionListener();
    this.ensureIntervalSync();
    this.dirty = this.sources.has("memory") && !meta;
  }

  async warmSession(_sessionKey?: string): Promise<void> {
    if (!this.settings.sync.onSessionStart) {
      return;
    }
    await this.sync({ reason: "session-start" });
  }

  async search(query: string, opts?: SearchOptions): Promise<MemorySearchResult[]> {
    void this.warmSession(opts?.sessionKey);
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    if (this.settings.sync.onSearch && (this.dirty || this.sessionsDirty)) {
      await this.sync({ reason: "search" });
    }
    const minScore = opts?.minScore ?? this.settings.query.minScore ?? DEFAULT_MIN_SCORE;
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    const hybrid = this.settings.query.hybrid;
    const candidates = Math.min(
      200,
      Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
    );

    const queryEmbeddings = await this.provider.embed([trimmed]);
    const queryVec = queryEmbeddings[0] ?? [];
    const sourceFilter = this.buildSourceFilter();

    const vectorResults = await searchVector({
      db: this.db,
      vectorTable: VECTOR_TABLE,
      providerModel: this.provider.model,
      queryVec,
      limit: candidates,
      snippetMaxChars: DEFAULT_SNIPPET_MAX_CHARS,
      ensureVectorReady: (dims) => this.ensureVectorReady(dims),
      sourceFilterVec: sourceFilter,
      sourceFilterChunks: sourceFilter,
    });

    if (!hybrid.enabled || !this.fts.enabled || !this.fts.available) {
      const baseResults = vectorResults.map(({ id: _id, ...rest }) => rest);
      const processed = await applyRecallPostProcessing({
        query: trimmed,
        results: baseResults,
        recall: this.settings.recall,
        resolveAbsolutePath: (relPath) => {
          try {
            return this.resolveAbsolutePath(relPath);
          } catch {
            return null;
          }
        },
      });
      return processed.filter((entry) => entry.score >= minScore).slice(0, maxResults);
    }

    const keywordResults = await searchKeyword({
      db: this.db,
      ftsTable: FTS_TABLE,
      providerModel: this.provider.model,
      query: trimmed,
      limit: candidates,
      snippetMaxChars: DEFAULT_SNIPPET_MAX_CHARS,
      sourceFilter,
      buildFtsQuery,
      bm25RankToScore,
    });

    const merged = await mergeHybridResults({
      vector: vectorResults.map((entry) => ({ ...entry, vectorScore: entry.score })),
      keyword: keywordResults.map((entry) => ({ ...entry, textScore: entry.textScore })),
      vectorWeight: hybrid.vectorWeight,
      textWeight: hybrid.textWeight,
    });

    const mergedResults = merged.map(({ id: _id, ...rest }) => rest);
    const processed = await applyRecallPostProcessing({
      query: trimmed,
      results: mergedResults,
      recall: this.settings.recall,
      resolveAbsolutePath: (relPath) => {
        try {
          return this.resolveAbsolutePath(relPath);
        } catch {
          return null;
        }
      },
    });

    return processed.filter((entry) => entry.score >= minScore).slice(0, maxResults);
  }

  async readFile(params: ReadFileParams): Promise<ReadFileResult> {
    const relPath = params.relPath?.trim();
    if (!relPath) {
      throw new Error("path required");
    }
    const { absPath, normalized } = this.resolveReadPath(relPath);
    const stat = await fs.lstat(absPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("invalid file type");
    }
    const content = await fs.readFile(absPath, "utf-8");
    if (!params.from && !params.lines) {
      return { text: content, path: normalized };
    }
    const lines = content.split(/\r?\n/);
    const from = Math.max(1, params.from ?? 1);
    const count = Math.max(1, params.lines ?? lines.length);
    const startIndex = Math.min(lines.length, from - 1);
    const endIndex = Math.min(lines.length, startIndex + count);
    const text = lines.slice(startIndex, endIndex).join("\n");
    return { text, path: normalized };
  }

  status(): MemoryProviderStatus {
    return {
      backend: "embedded",
      provider: this.provider.id,
      model: this.provider.model,
      files: this.fileCounts.get("memory") ?? 0,
      chunks: this.chunkCounts.get("memory") ?? 0,
      workspaceDir: this.workspaceDir,
      dbPath: this.settings.store.path,
      sources: Array.from(this.sources),
      sourceCounts: Array.from(this.sources).map((source) => ({
        source,
        files: this.fileCounts.get(source) ?? 0,
        chunks: this.chunkCounts.get(source) ?? 0,
      })),
      dirty: this.dirty || this.sessionsDirty,
      fts: {
        enabled: this.fts.enabled,
        available: this.fts.available,
        error: this.fts.error,
      },
      vector: {
        enabled: this.vector.enabled,
        available: this.vector.available ?? undefined,
        dims: this.vector.dims,
        extensionPath: this.vector.extensionPath,
        loadError: this.vector.loadError,
      },
      custom: {
        embedded: {
          requestedProvider: this.settings.requestedProvider,
          provider: this.provider.id,
          baseUrl: this.settings.remote.baseUrl,
          sources: Array.from(this.sources),
        },
      },
    };
  }

  async sync(params?: SyncParams): Promise<void> {
    if (this.syncing) {
      return this.syncing;
    }
    this.syncing = this.runSync(params).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  markDirty(): void {
    this.dirty = true;
    this.scheduleWatchSync();
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    if (!this.provider.model || !this.provider.id) {
      return { ok: false, error: "embedding provider not configured" };
    }
    return { ok: true };
  }

  async probeVectorAvailability(): Promise<boolean> {
    if (!this.vector.enabled || !this.vector.dims) {
      return false;
    }
    return await this.ensureVectorReady(this.vector.dims);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.sessionSyncTimer) {
      clearTimeout(this.sessionSyncTimer);
      this.sessionSyncTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.sessionUnsubscribe) {
      this.sessionUnsubscribe();
      this.sessionUnsubscribe = null;
    }
    this.db.close();
  }

  private openDatabase(): DatabaseType {
    const dbPath = this.settings.store.path;
    ensureDir(path.dirname(dbPath));
    return new Database(dbPath);
  }

  private async runSync(params?: SyncParams): Promise<void> {
    if (this.closed) {
      return;
    }
    const meta = this.readMeta();
    const providerChanged =
      meta?.provider !== this.provider.id ||
      meta?.model !== this.provider.model ||
      meta?.providerKey !== this.providerKey;
    const needsFullReindex = Boolean(params?.force) || providerChanged || !meta;
    if (needsFullReindex) {
      this.resetIndex({ clearCache: providerChanged || Boolean(params?.force) });
    }

    await this.syncMemoryFiles({ needsFullReindex, progress: params?.progress });
    await this.syncSessionFiles({ needsFullReindex, progress: params?.progress });

    this.dirty = false;
    this.sessionsDirty = false;
    this.sessionsDirtyFiles.clear();
    this.refreshCounts();
    this.writeMeta({
      provider: this.provider.id,
      model: this.provider.model,
      providerKey: this.providerKey,
      vectorDims: this.vector.dims,
    });
  }

  private async syncMemoryFiles(params: {
    needsFullReindex: boolean;
    progress?: SyncParams["progress"];
  }) {
    if (!this.sources.has("memory")) {
      return;
    }
    const files = await listMemoryFiles(this.workspaceDir);
    const fileEntries = (
      await Promise.all(files.map(async (file) => buildFileEntry(file, this.workspaceDir)))
    ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const activePaths = new Set(fileEntries.map((entry) => entry.path));
    if (params.progress) {
      params.progress({ completed: 0, total: fileEntries.length, label: "Indexing memory files…" });
    }
    let completed = 0;
    for (const entry of fileEntries) {
      const record = this.db
        .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
        .get(entry.path, "memory") as { hash: string } | undefined;
      if (!params.needsFullReindex && record?.hash === entry.hash) {
        completed += 1;
        params.progress?.({ completed, total: fileEntries.length });
        continue;
      }
      await this.indexFile(entry, { source: "memory" });
      completed += 1;
      params.progress?.({ completed, total: fileEntries.length, label: entry.path });
    }

    const staleRows = this.db
      .prepare(`SELECT path FROM files WHERE source = ?`)
      .all("memory") as Array<{ path: string }>;
    for (const stale of staleRows) {
      if (activePaths.has(stale.path)) {
        continue;
      }
      this.deletePath(stale.path, "memory");
    }
  }

  private async syncSessionFiles(params: {
    needsFullReindex: boolean;
    progress?: SyncParams["progress"];
  }) {
    if (!this.sources.has("sessions")) {
      return;
    }
    if (!params.needsFullReindex && !this.sessionsDirty) {
      return;
    }
    const files = await listSessionFiles({
      sessionsDir: this.sessionsDir,
      agentId: this.agentId,
    });
    const activePaths = new Set(files.map((file) => sessionPathForFile(file)));
    if (params.progress) {
      params.progress({ completed: 0, total: files.length, label: "Indexing session files…" });
    }
    let completed = 0;
    for (const absPath of files) {
      if (!params.needsFullReindex && this.sessionsDirtyFiles.size > 0) {
        if (!this.sessionsDirtyFiles.has(absPath)) {
          completed += 1;
          params.progress?.({ completed, total: files.length });
          continue;
        }
      }
      const entry = await buildSessionEntry(absPath);
      if (!entry) {
        completed += 1;
        params.progress?.({ completed, total: files.length });
        continue;
      }
      const record = this.db
        .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
        .get(entry.path, "sessions") as { hash: string } | undefined;
      if (!params.needsFullReindex && record?.hash === entry.hash) {
        completed += 1;
        params.progress?.({ completed, total: files.length });
        continue;
      }
      await this.indexSessionEntry(entry);
      completed += 1;
      params.progress?.({ completed, total: files.length, label: entry.path });
    }

    const staleRows = this.db
      .prepare(`SELECT path FROM files WHERE source = ?`)
      .all("sessions") as Array<{ path: string }>;
    for (const stale of staleRows) {
      if (activePaths.has(stale.path)) {
        continue;
      }
      this.deletePath(stale.path, "sessions");
    }
  }

  private async indexFile(
    entry: NonNullable<Awaited<ReturnType<typeof buildFileEntry>>>,
    options: { source: MemorySource },
  ): Promise<void> {
    const content = await fs.readFile(entry.absPath, "utf-8");
    const chunks = chunkMarkdown(content, this.settings.chunking);
    await this.writeChunks(entry, chunks, options.source);
  }

  private async indexSessionEntry(entry: Awaited<ReturnType<typeof buildSessionEntry>>): Promise<void> {
    if (!entry) {
      return;
    }
    const chunks = chunkMarkdown(entry.content, this.settings.chunking);
    remapChunkLines(chunks, entry.lineMap);
    await this.writeChunks(entry, chunks, "sessions");
  }

  private async writeChunks(
    entry: { path: string; hash: string; mtimeMs: number; size: number },
    chunks: Array<{ startLine: number; endLine: number; text: string; hash: string }>,
    source: MemorySource,
  ): Promise<void> {
    const embeddings = await this.embedChunks(chunks);
    const sample = embeddings.find((embedding) => embedding.length > 0);
    const vectorReady = sample ? await this.ensureVectorReady(sample.length) : false;
    const now = Date.now();
    if (vectorReady) {
      try {
        this.db
          .prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
          .run(entry.path, source);
      } catch {}
    }
    if (this.fts.enabled && this.fts.available) {
      try {
        this.db
          .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
          .run(entry.path, source, this.provider.model);
      } catch {}
    }
    this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(entry.path, source);

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const embedding = embeddings[i] ?? [];
      const id = hashText(
        `${source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${this.provider.model}`,
      );
      this.db
        .prepare(
          `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             hash=excluded.hash,
             model=excluded.model,
             text=excluded.text,
             embedding=excluded.embedding,
             updated_at=excluded.updated_at`,
        )
        .run(
          id,
          entry.path,
          source,
          chunk.startLine,
          chunk.endLine,
          chunk.hash,
          this.provider.model,
          chunk.text,
          JSON.stringify(embedding),
          now,
        );
      if (vectorReady && embedding.length > 0) {
        try {
          this.db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`).run(id);
        } catch {}
        this.db
          .prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`)
          .run(id, vectorToBlob(embedding));
      }
      if (this.fts.enabled && this.fts.available) {
        this.db
          .prepare(
            `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line)\n` +
              ` VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            chunk.text,
            id,
            entry.path,
            source,
            this.provider.model,
            chunk.startLine,
            chunk.endLine,
          );
      }
    }
    this.db
      .prepare(
        `INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           source=excluded.source,
           hash=excluded.hash,
           mtime=excluded.mtime,
           size=excluded.size`,
      )
      .run(entry.path, source, entry.hash, entry.mtimeMs, entry.size);
  }

  private async embedChunks(
    chunks: Array<{ text: string; hash: string }>,
  ): Promise<number[][]> {
    if (chunks.length === 0) {
      return [];
    }
    const { embeddings, missing } = this.collectCachedEmbeddings(chunks);
    if (missing.length === 0) {
      return embeddings;
    }
    const missingTexts = missing.map((item) => item.chunk.text);
    const fresh = await this.provider.embed(missingTexts);
    const toCache: Array<{ hash: string; embedding: number[] }> = [];
    for (let i = 0; i < missing.length; i += 1) {
      const entry = missing[i];
      const embedding = fresh[i] ?? [];
      embeddings[entry.index] = embedding;
      if (embedding.length > 0) {
        toCache.push({ hash: entry.chunk.hash, embedding });
      }
    }
    this.upsertEmbeddingCache(toCache);
    return embeddings;
  }

  private collectCachedEmbeddings(chunks: Array<{ hash: string }>): {
    embeddings: number[][];
    missing: Array<{ index: number; chunk: { hash: string; text: string } }>;
  } {
    const hashes = chunks.map((chunk) => chunk.hash).filter(Boolean);
    const cached = this.loadEmbeddingCache(hashes);
    const embeddings: number[][] = Array.from({ length: chunks.length }, () => []);
    const missing: Array<{ index: number; chunk: { hash: string; text: string } }> = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const hit = cached.get(chunk.hash);
      if (hit && hit.length > 0) {
        embeddings[i] = hit;
      } else {
        missing.push({ index: i, chunk });
      }
    }
    return { embeddings, missing };
  }

  private loadEmbeddingCache(hashes: string[]): Map<string, number[]> {
    const unique = Array.from(new Set(hashes)).filter(Boolean);
    const result = new Map<string, number[]>();
    if (unique.length === 0) {
      return result;
    }
    const placeholders = unique.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT hash, embedding FROM ${EMBEDDING_CACHE_TABLE}\n` +
          ` WHERE provider = ? AND model = ? AND provider_key = ? AND hash IN (${placeholders})`,
      )
      .all(this.provider.id, this.provider.model, this.providerKey, ...unique) as Array<{
      hash: string;
      embedding: string;
    }>;
    for (const row of rows) {
      try {
        const embedding = JSON.parse(row.embedding) as number[];
        if (Array.isArray(embedding)) {
          result.set(row.hash, embedding);
        }
      } catch {}
    }
    return result;
  }

  private upsertEmbeddingCache(entries: Array<{ hash: string; embedding: number[] }>): void {
    if (!this.settings.cache.enabled || entries.length === 0) {
      return;
    }
    const now = Date.now();
    const insert = this.db.prepare(
      `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET
         embedding=excluded.embedding,
         dims=excluded.dims,
         updated_at=excluded.updated_at`,
    );
    const runInsert = this.db.transaction(
      (batch: Array<{ hash: string; embedding: number[] }>) => {
        for (const entry of batch) {
          insert.run(
            this.provider.id,
            this.provider.model,
            this.providerKey,
            entry.hash,
            JSON.stringify(entry.embedding),
            entry.embedding.length,
            now,
          );
        }
      },
    );
    runInsert(entries);
    this.pruneEmbeddingCache();
  }

  private pruneEmbeddingCache(): void {
    const limit = this.settings.cache.maxEntries;
    if (!limit || limit <= 0) {
      return;
    }
    try {
      this.db
        .prepare(
          `DELETE FROM ${EMBEDDING_CACHE_TABLE}\n` +
            ` WHERE provider = ? AND model = ? AND provider_key = ? AND rowid IN (\n` +
            `   SELECT rowid FROM ${EMBEDDING_CACHE_TABLE}\n` +
            `    WHERE provider = ? AND model = ? AND provider_key = ?\n` +
            `    ORDER BY updated_at DESC\n` +
            `    LIMIT -1 OFFSET ?\n` +
            ` )`,
        )
        .run(
          this.provider.id,
          this.provider.model,
          this.providerKey,
          this.provider.id,
          this.provider.model,
          this.providerKey,
          limit,
        );
    } catch {}
  }

  private deletePath(pathValue: string, source: MemorySource): void {
    this.db.prepare(`DELETE FROM files WHERE path = ? AND source = ?`).run(pathValue, source);
    try {
      this.db
        .prepare(
          `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
        )
        .run(pathValue, source);
    } catch {}
    this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(pathValue, source);
    if (this.fts.enabled && this.fts.available) {
      try {
        this.db
          .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
          .run(pathValue, source, this.provider.model);
      } catch {}
    }
  }

  private resetIndex(params: { clearCache: boolean }): void {
    try {
      this.db.exec("DELETE FROM files;");
      this.db.exec("DELETE FROM chunks;");
      if (this.fts.enabled && this.fts.available) {
        try {
          this.db.exec(`DELETE FROM ${FTS_TABLE};`);
        } catch {}
      }
      if (this.vector.enabled) {
        try {
          this.db.exec(`DELETE FROM ${VECTOR_TABLE};`);
        } catch {}
      }
      if (params.clearCache) {
        this.db.exec(`DELETE FROM ${EMBEDDING_CACHE_TABLE};`);
      }
    } catch (err) {
      logger.warn(`embedded memory reset failed: ${String(err)}`);
    }
  }

  private ensureWatcher(): void {
    if (!this.settings.sync.watch || this.watcher) {
      return;
    }
    const watchPaths = [
      path.join(this.workspaceDir, "MEMORY.md"),
      path.join(this.workspaceDir, "memory.md"),
      path.join(this.workspaceDir, "memory"),
    ];
    this.watcher = chokidar.watch(watchPaths, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: Math.max(0, this.settings.sync.watchDebounceMs),
        pollInterval: 100,
      },
    });
    const markDirty = () => {
      this.markDirty();
    };
    this.watcher.on("add", markDirty);
    this.watcher.on("change", markDirty);
    this.watcher.on("unlink", markDirty);
  }

  private ensureSessionListener(): void {
    if (!this.sources.has("sessions") || this.sessionUnsubscribe) {
      return;
    }
    this.sessionUnsubscribe = onSessionTranscriptUpdate((update) => {
      const absPath = update.sessionFile;
      if (!absPath) {
        return;
      }
      const targetDir = path.join(this.sessionsDir, this.agentId) + path.sep;
      if (!absPath.startsWith(targetDir)) {
        return;
      }
      this.sessionsDirty = true;
      this.sessionsDirtyFiles.add(absPath);
      if (this.settings.sync.watch) {
        this.scheduleSessionSync();
      }
    });
  }

  private scheduleWatchSync(): void {
    if (!this.settings.sync.watch) {
      return;
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    const delay = Math.max(0, this.settings.sync.watchDebounceMs);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.sync({ reason: "watch" }).catch((err) => {
        logger.warn(`embedded memory sync failed (watch): ${String(err)}`);
      });
    }, delay);
  }

  private scheduleSessionSync(): void {
    if (this.sessionSyncTimer) {
      clearTimeout(this.sessionSyncTimer);
    }
    const delay = Math.max(0, this.settings.sync.watchDebounceMs);
    this.sessionSyncTimer = setTimeout(() => {
      this.sessionSyncTimer = null;
      void this.sync({ reason: "session-transcript" }).catch((err) => {
        logger.warn(`embedded memory sync failed (session-transcript): ${String(err)}`);
      });
    }, delay);
  }

  private ensureIntervalSync(): void {
    const minutes = this.settings.sync.intervalMinutes;
    if (!minutes || minutes <= 0 || this.intervalTimer) {
      return;
    }
    const ms = minutes * 60 * 1000;
    this.intervalTimer = setInterval(() => {
      void this.sync({ reason: "interval" }).catch((err) => {
        logger.warn(`embedded memory sync failed (interval): ${String(err)}`);
      });
    }, ms);
  }

  private refreshCounts(): void {
    const fileRows = this.db
      .prepare(`SELECT source, COUNT(*) as count FROM files GROUP BY source`)
      .all() as Array<{ source: MemorySource; count: number }>;
    const chunkRows = this.db
      .prepare(`SELECT source, COUNT(*) as count FROM chunks GROUP BY source`)
      .all() as Array<{ source: MemorySource; count: number }>;
    this.fileCounts = new Map(fileRows.map((row) => [row.source, row.count]));
    this.chunkCounts = new Map(chunkRows.map((row) => [row.source, row.count]));
  }

  private buildSourceFilter(alias?: string): { sql: string; params: MemorySource[] } {
    const sources = Array.from(this.sources);
    if (sources.length === 0) {
      return { sql: "", params: [] };
    }
    const column = alias ? `${alias}.source` : "source";
    const placeholders = sources.map(() => "?").join(", ");
    return { sql: ` AND ${column} IN (${placeholders})`, params: sources };
  }

  private async ensureVectorReady(dimensions: number): Promise<boolean> {
    if (!this.vector.enabled) {
      return false;
    }
    if (!this.vectorReady) {
      this.vectorReady = this.loadVectorExtension().finally(() => {
        this.vectorReady = null;
      });
    }
    const ready = (await this.vectorReady) || false;
    if (!ready) {
      return false;
    }
    if (this.vector.dims === dimensions) {
      return true;
    }
    if (this.vector.dims && this.vector.dims !== dimensions) {
      this.dropVectorTable();
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(\n` +
        `  id TEXT PRIMARY KEY,\n` +
        `  embedding FLOAT[${dimensions}]\n` +
        `)`,
    );
    this.vector.dims = dimensions;
    return true;
  }

  private async loadVectorExtension(): Promise<boolean> {
    if (this.vector.available !== null) {
      return this.vector.available;
    }
    if (!this.vector.enabled) {
      this.vector.available = false;
      return false;
    }
    const loaded = await loadSqliteVecExtension({
      db: this.db,
      extensionPath: this.vector.extensionPath,
    });
    if (loaded.ok) {
      this.vector.extensionPath = loaded.extensionPath ?? this.vector.extensionPath;
      this.vector.available = true;
      return true;
    }
    this.vector.available = false;
    this.vector.loadError = loaded.error;
    logger.warn(`sqlite-vec unavailable: ${loaded.error}`);
    return false;
  }

  private dropVectorTable(): void {
    try {
      this.db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
    } catch (err) {
      logger.debug(`Failed to drop ${VECTOR_TABLE}: ${String(err)}`);
    }
  }

  private readMeta(): EmbeddedMeta | null {
    try {
      const row = this.db
        .prepare(`SELECT value FROM meta WHERE key = ?`)
        .get("embedded") as { value: string } | undefined;
      if (!row?.value) {
        return null;
      }
      const parsed = JSON.parse(row.value) as EmbeddedMeta;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  private writeMeta(meta: EmbeddedMeta): void {
    try {
      const payload = JSON.stringify(meta);
      this.db
        .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run("embedded", payload);
    } catch {
      // ignore
    }
  }

  private resolveReadPath(relPath: string): { absPath: string; normalized: string } {
    const normalized = relPath.replace(/\\/g, "/");
    if (normalized.startsWith("sessions/") && this.sources.has("sessions")) {
      const filename = path.basename(normalized);
      if (!filename.endsWith(".jsonl")) {
        throw new Error("only .jsonl session files allowed");
      }
      const absPath = path.join(this.sessionsDir, this.agentId, filename);
      return { absPath, normalized: `sessions/${filename}` };
    }
    if (!isMemoryPath(normalized)) {
      throw new Error("path required");
    }
    if (!normalized.endsWith(".md")) {
      throw new Error("only .md files allowed");
    }
    const absPath = path.resolve(this.workspaceDir, normalized);
    const rel = path.relative(this.workspaceDir, absPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("path escapes workspace");
    }
    return { absPath, normalized };
  }

  private resolveAbsolutePath(relPath: string): string | null {
    const normalized = relPath.replace(/\\/g, "/");
    if (normalized.startsWith("sessions/")) {
      const filename = path.basename(normalized);
      return path.join(this.sessionsDir, this.agentId, filename);
    }
    if (isMemoryPath(normalized)) {
      return path.resolve(this.workspaceDir, normalized);
    }
    return null;
  }
}

function resolveSessionsDir(config: MoziConfig): string {
  let base = config.paths?.sessions;
  if (!base) {
    const tempBase = path.join(os.tmpdir(), "mozi");
    base = path.join(tempBase, "sessions");
  }
  if (!path.isAbsolute(base)) {
    if (config.paths?.baseDir) {
      base = path.resolve(config.paths.baseDir, base);
    } else {
      base = path.resolve(base);
    }
  }
  return base;
}

function resolveHomeDir(cfg: MoziConfig, agentId: string): string {
  const agents = cfg.agents as Record<string, { home?: string }> | undefined;
  const entry = agents?.[agentId];
  if (entry?.home) {
    return entry.home;
  }
  const baseDir = cfg.paths?.baseDir;
  if (baseDir) {
    return path.join(baseDir, "agents", agentId, "home");
  }
  return path.join(".", "agents", agentId, "home");
}

function vectorToBlob(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}
