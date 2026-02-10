import Database, { type Database as DatabaseType } from "better-sqlite3";
import chokidar, { type FSWatcher } from "chokidar";
import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedBuiltinMemoryConfig } from "./backend-config";
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
} from "./types";
import { logger } from "../logger";

const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MIN_SCORE = 0.3;
const SNIPPET_MAX_CHARS = 700;
const SNIPPET_WINDOW = 120;

interface BuiltinManagerParams {
  workspaceDir: string;
  dbPath: string;
  config?: ResolvedBuiltinMemoryConfig;
}

type FtsRow = {
  path: string;
  content: string;
  snippet: string;
  score: number;
};

type LikeRow = {
  path: string;
  content: string;
};

export class BuiltinMemoryManager implements MemorySearchManager {
  private readonly db: DatabaseType;
  private readonly workspaceDir: string;
  private readonly dbPath: string;
  private readonly config: ResolvedBuiltinMemoryConfig;
  private ftsAvailable = false;
  private ftsError?: string;
  private synced = false;
  private dirty = true;
  private syncing: Promise<void> | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private fileCount = 0;
  private chunkCount = 0;

  constructor(params: BuiltinManagerParams) {
    this.workspaceDir = params.workspaceDir;
    this.dbPath = params.dbPath;
    this.config = params.config ?? {
      sync: {
        onSessionStart: true,
        onSearch: true,
        watch: true,
        watchDebounceMs: 1500,
        intervalMinutes: 0,
        forceOnFlush: true,
      },
    };
    this.db = new Database(this.dbPath);
    this.ftsAvailable = this.checkFts5Support();
    this.initSchema();
    this.ensureWatcher();
    this.ensureIntervalSync();
  }

  async search(query: string, opts?: SearchOptions): Promise<MemorySearchResult[]> {
    const normalized = query.trim();
    if (!normalized) {
      return [];
    }
    if (this.config.sync.onSearch && this.dirty) {
      await this.sync({ reason: "search" });
    } else {
      await this.ensureSynced();
    }

    const maxResults = opts?.maxResults ?? DEFAULT_MAX_RESULTS;
    const minScore = opts?.minScore ?? DEFAULT_MIN_SCORE;

    if (this.ftsAvailable) {
      try {
        const results = this.searchFts(normalized, maxResults, minScore);
        return results;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`FTS5 search failed; falling back to LIKE: ${message}`);
      }
    }

    return this.searchLike(normalized, maxResults, minScore);
  }

  async readFile(params: ReadFileParams): Promise<ReadFileResult> {
    const relPath = params.relPath?.trim();
    if (!relPath) {
      throw new Error("path required");
    }

    const absPath = this.resolveReadPath(relPath);

    if (!absPath.endsWith(".md")) {
      throw new Error("only .md files allowed");
    }

    const stat = await fs.lstat(absPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("invalid file type");
    }

    const content = await fs.readFile(absPath, "utf-8");
    const lines = content.split(/\r?\n/);
    const from = Math.max(1, params.from ?? 1);
    const count = params.lines ?? lines.length;
    const startIndex = Math.min(lines.length, from - 1);
    const endIndex = Math.min(lines.length, startIndex + count);
    const text = lines.slice(startIndex, endIndex).join("\n");

    return { text, path: relPath };
  }

  status(): MemoryProviderStatus {
    return {
      backend: "builtin",
      provider: "builtin",
      files: this.fileCount,
      chunks: this.chunkCount,
      workspaceDir: this.workspaceDir,
      dbPath: this.dbPath,
      sources: ["memory"],
      sourceCounts: [
        {
          source: "memory" satisfies MemorySource,
          files: this.fileCount,
          chunks: this.chunkCount,
        },
      ],
      dirty: this.dirty,
      fts: {
        enabled: true,
        available: this.ftsAvailable,
        error: this.ftsError,
      },
      vector: {
        enabled: false,
        available: false,
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

  async warmSession(_sessionKey?: string): Promise<void> {
    if (!this.config.sync.onSessionStart) {
      return;
    }
    await this.sync({ reason: "session-start" });
  }

  private async runSync(params?: SyncParams): Promise<void> {
    const files = await listMemoryFiles(this.workspaceDir);
    this.fileCount = files.length;
    this.chunkCount = files.length;

    if (this.ftsAvailable) {
      this.db.exec("DELETE FROM memory_fts;");
    } else {
      this.db.exec("DELETE FROM memory_docs;");
    }

    const insert = this.ftsAvailable
      ? this.db.prepare("INSERT INTO memory_fts (path, content) VALUES (?, ?)")
      : this.db.prepare("INSERT INTO memory_docs (path, content) VALUES (?, ?)");

    const total = files.length;
    let completed = 0;

    const entries: Array<[string, string]> = [];
    for (const file of files) {
      const content = await fs.readFile(file.absPath, "utf-8");
      entries.push([file.relPath, content]);
    }

    const runInsert = this.db.transaction((batch: Array<[string, string]>) => {
      for (const [relPath, content] of batch) {
        insert.run(relPath, content);
      }
    });

    for (const entry of entries) {
      runInsert([entry]);
      completed += 1;
      params?.progress?.({
        completed,
        total,
        label: entry[0],
      });
    }

    this.synced = true;
    this.dirty = false;
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return {
      ok: false,
      error: "embeddings are not available in builtin memory",
    };
  }

  async probeVectorAvailability(): Promise<boolean> {
    return false;
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
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.db.close();
  }

  private checkFts5Support(): boolean {
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS _fts_probe USING fts5(x)");
      this.db.exec("DROP TABLE _fts_probe");
      return true;
    } catch (error) {
      this.ftsError = error instanceof Error ? error.message : String(error);
      logger.warn("FTS5 not available in this SQLite build");
      return false;
    }
  }

  private initSchema(): void {
    if (this.ftsAvailable) {
      this.db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(path, content, tokenize='trigram');",
      );
    } else {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_docs (
          id INTEGER PRIMARY KEY,
          path TEXT NOT NULL,
          content TEXT NOT NULL
        );
      `);
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_path ON memory_docs(path);");
    }
  }

  private async ensureSynced(): Promise<void> {
    if (this.synced && !this.dirty) {
      return;
    }
    await this.sync();
  }

  private ensureWatcher(): void {
    if (!this.config.sync.watch || this.watcher) {
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
        stabilityThreshold: Math.max(0, this.config.sync.watchDebounceMs),
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

  private ensureIntervalSync(): void {
    const minutes = this.config.sync.intervalMinutes;
    if (!minutes || minutes <= 0 || this.intervalTimer) {
      return;
    }
    const ms = minutes * 60 * 1000;
    this.intervalTimer = setInterval(() => {
      void this.sync({ reason: "interval" }).catch((err) => {
        logger.warn(`builtin memory sync failed (interval): ${String(err)}`);
      });
    }, ms);
  }

  markDirty(): void {
    this.dirty = true;
    this.synced = false;
    this.scheduleWatchSync();
  }

  private scheduleWatchSync(): void {
    if (!this.config.sync.watch) {
      return;
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    const delay = Math.max(0, this.config.sync.watchDebounceMs);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.sync({ reason: "watch" }).catch((err) => {
        logger.warn(`builtin memory sync failed (watch): ${String(err)}`);
      });
    }, delay);
  }

  private searchFts(query: string, maxResults: number, minScore: number): MemorySearchResult[] {
    const rows = this.db
      .prepare(
        `
        SELECT path,
               content,
               snippet(memory_fts, 1, '', '', '...', 64) as snippet,
               bm25(memory_fts) as score
        FROM memory_fts
        WHERE memory_fts MATCH ?
        ORDER BY score
        LIMIT ?
      `,
      )
      .all(query, maxResults) as FtsRow[];

    return rows
      .map((row) => {
        const score = normalizeBm25(row.score);
        const snippet = clampSnippet(row.snippet || row.content, query);
        const lineRange = computeLineRange(row.content, snippet, query);
        return {
          path: row.path,
          startLine: lineRange.startLine,
          endLine: lineRange.endLine,
          score,
          snippet,
          source: "memory" as MemorySource,
        };
      })
      .filter((entry) => entry.score >= minScore);
  }

  private searchLike(query: string, maxResults: number, minScore: number): MemorySearchResult[] {
    const escaped = escapeLike(query);
    const rows = this.db
      .prepare("SELECT path, content FROM memory_docs WHERE content LIKE ? ESCAPE '\\' LIMIT ?")
      .all(`%${escaped}%`, maxResults) as LikeRow[];

    return rows
      .map((row) => {
        const score = normalizeOccurrences(row.content, query);
        const snippet = buildSnippet(row.content, query);
        const lineRange = computeLineRange(row.content, snippet, query);
        return {
          path: row.path,
          startLine: lineRange.startLine,
          endLine: lineRange.endLine,
          score,
          snippet,
          source: "memory" as MemorySource,
        };
      })
      .filter((entry) => entry.score >= minScore);
  }

  private resolveReadPath(relPath: string): string {
    const absPath = path.resolve(this.workspaceDir, relPath);
    if (!isWithinDir(this.workspaceDir, absPath)) {
      throw new Error("path escapes workspace");
    }
    return absPath;
  }
}

function normalizeBm25(score: number): number {
  return 1 / (1 + Math.abs(score));
}

function normalizeOccurrences(content: string, query: string): number {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (!lowerQuery) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (true) {
    const found = lowerContent.indexOf(lowerQuery, index);
    if (found === -1) {
      break;
    }
    count += 1;
    index = found + lowerQuery.length;
  }
  return Math.min(1, count / 2);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function clampSnippet(snippet: string, query: string): string {
  const trimmed = snippet.trim();
  if (!trimmed) {
    return buildSnippet(snippet, query);
  }
  if (trimmed.length <= SNIPPET_MAX_CHARS) {
    return trimmed;
  }
  return trimmed.slice(0, SNIPPET_MAX_CHARS);
}

function buildSnippet(content: string, query: string): string {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerContent.indexOf(lowerQuery);
  if (index === -1) {
    return content.slice(0, SNIPPET_MAX_CHARS).trim();
  }

  const start = Math.max(0, index - SNIPPET_WINDOW);
  const end = Math.min(content.length, index + lowerQuery.length + SNIPPET_WINDOW);
  let snippet = content.slice(start, end).trim();
  if (start > 0) {
    snippet = `...${snippet}`;
  }
  if (end < content.length) {
    snippet = `${snippet}...`;
  }
  if (snippet.length > SNIPPET_MAX_CHARS) {
    snippet = snippet.slice(0, SNIPPET_MAX_CHARS);
  }
  return snippet;
}

function computeLineRange(
  content: string,
  snippet: string,
  query: string,
): { startLine: number; endLine: number } {
  const matchIndex = findMatchIndex(content, snippet, query);
  if (matchIndex < 0) {
    return { startLine: 1, endLine: 1 };
  }

  const before = content.slice(0, matchIndex);
  const startLine = before.split(/\r?\n/).length;
  const endIndex = Math.min(content.length, matchIndex + snippet.length);
  const endLine = content.slice(0, endIndex).split(/\r?\n/).length;
  return { startLine, endLine: Math.max(startLine, endLine) };
}

function findMatchIndex(content: string, snippet: string, query: string): number {
  const trimmedSnippet = snippet.replace(/\.\.\./g, "").trim();
  if (trimmedSnippet) {
    const index = content.indexOf(trimmedSnippet);
    if (index >= 0) {
      return index;
    }
  }

  const token = extractFirstToken(query);
  if (!token) {
    return -1;
  }
  return content.toLowerCase().indexOf(token.toLowerCase());
}

function extractFirstToken(query: string): string {
  const cleaned = query.replace(/["'`]/g, " ").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  return parts[0] ?? "";
}

function isWithinDir(baseDir: string, targetPath: string): boolean {
  const relative = path.relative(baseDir, targetPath);
  if (!relative) {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function listMemoryFiles(
  workspaceDir: string,
): Promise<Array<{ relPath: string; absPath: string }>> {
  const results: Array<{ relPath: string; absPath: string }> = [];
  const memoryFile = path.join(workspaceDir, "MEMORY.md");
  if (await fileExists(memoryFile)) {
    results.push({
      relPath: toRelPath(workspaceDir, memoryFile),
      absPath: memoryFile,
    });
  }

  const memoryDir = path.join(workspaceDir, "memory");
  if (await dirExists(memoryDir)) {
    const entries = await readDirectoryRecursive(memoryDir);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) {
        continue;
      }
      results.push({
        relPath: toRelPath(workspaceDir, entry),
        absPath: entry,
      });
    }
  }

  return results;
}

async function readDirectoryRecursive(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await readDirectoryRecursive(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(dirPath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function toRelPath(workspaceDir: string, absPath: string): string {
  const rel = path.relative(workspaceDir, absPath);
  return rel.split(path.sep).join("/");
}
