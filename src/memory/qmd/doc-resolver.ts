import Database, { type Database as DatabaseType } from "better-sqlite3";
import path from "node:path";
import type { MemorySource } from "../types";
import { logger } from "../../logger";
import { buildSearchPath, type CollectionRoot } from "./path-utils";

export class QmdDocResolver {
  private db: DatabaseType | null = null;
  private readonly docPathCache = new Map<
    string,
    { rel: string; abs: string; source: MemorySource }
  >();

  constructor(
    private readonly indexPath: string,
    private readonly workspaceDir: string,
    private readonly collectionRoots: Map<string, CollectionRoot>,
    private readonly sources: Set<MemorySource>,
  ) {}

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  clearCache(): void {
    this.docPathCache.clear();
  }

  async resolveDocLocation(
    docid?: string,
  ): Promise<{ rel: string; abs: string; source: MemorySource } | null> {
    if (!docid) {
      return null;
    }
    const normalized = docid.startsWith("#") ? docid.slice(1) : docid;
    if (!normalized) {
      return null;
    }
    const cached = this.docPathCache.get(normalized);
    if (cached) {
      return cached;
    }
    try {
      const db = this.ensureDb();
      const row = db
        .prepare("SELECT collection, path FROM documents WHERE hash LIKE ? AND active = 1 LIMIT 1")
        .get(`${normalized}%`) as { collection: string; path: string } | undefined;
      if (!row) {
        return null;
      }
      const location = this.toDocLocation(row.collection, row.path);
      if (!location) {
        return null;
      }
      this.docPathCache.set(normalized, location);
      return location;
    } catch (err) {
      logger.warn(`failed to read qmd doc location: ${String(err)}`);
      return null;
    }
  }

  readCounts(): {
    totalDocuments: number;
    sourceCounts: Array<{ source: MemorySource; files: number; chunks: number }>;
  } {
    try {
      const db = this.ensureDb();
      const rows = db
        .prepare(
          "SELECT collection, COUNT(*) as c FROM documents WHERE active = 1 GROUP BY collection",
        )
        .all() as Array<{ collection: string; c: number }>;
      const bySource = new Map<MemorySource, { files: number; chunks: number }>();
      for (const source of this.sources) {
        bySource.set(source, { files: 0, chunks: 0 });
      }
      let total = 0;
      for (const row of rows) {
        const root = this.collectionRoots.get(row.collection);
        const source = root?.kind ?? "memory";
        const entry = bySource.get(source) ?? { files: 0, chunks: 0 };
        entry.files += row.c ?? 0;
        entry.chunks += row.c ?? 0;
        bySource.set(source, entry);
        total += row.c ?? 0;
      }
      return {
        totalDocuments: total,
        sourceCounts: Array.from(bySource.entries()).map(([source, value]) => ({
          source,
          files: value.files,
          chunks: value.chunks,
        })),
      };
    } catch (err) {
      logger.warn(`failed to read qmd index stats: ${String(err)}`);
      return {
        totalDocuments: 0,
        sourceCounts: Array.from(this.sources).map((source) => ({
          source,
          files: 0,
          chunks: 0,
        })),
      };
    }
  }

  private ensureDb(): DatabaseType {
    if (this.db) {
      return this.db;
    }
    this.db = new Database(this.indexPath, { readonly: true });
    return this.db;
  }

  private toDocLocation(
    collection: string,
    collectionRelativePath: string,
  ): { rel: string; abs: string; source: MemorySource } | null {
    const root = this.collectionRoots.get(collection);
    if (!root) {
      return null;
    }
    const normalizedRelative = collectionRelativePath.replace(/\\/g, "/");
    const absPath = path.normalize(path.resolve(root.path, collectionRelativePath));
    const relativeToWorkspace = path.relative(this.workspaceDir, absPath);
    const relPath = buildSearchPath({
      collection,
      collectionRelativePath: normalizedRelative,
      relativeToWorkspace,
      absPath,
    });
    return { rel: relPath, abs: absPath, source: root.kind };
  }
}
