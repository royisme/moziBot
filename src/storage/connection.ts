import Database, { type Database as DatabaseType } from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../logger";
import { runMigrations } from "./migrations";

const DB_PATH = "data/mozi.db";
const DEFAULT_POOL_SIZE = 4;

class ConnectionPool {
  private connections: DatabaseType[] = [];
  private available: DatabaseType[] = [];
  private dbPath: string;
  private maxSize: number;
  private initialized = false;

  constructor(dbPath: string, maxSize: number = DEFAULT_POOL_SIZE) {
    this.dbPath = dbPath;
    this.maxSize = maxSize;
  }

  initialize(): void {
    if (this.initialized) {
      return;
    }

    const primary = new Database(this.dbPath);
    this.setupConnection(primary);
    this.connections.push(primary);
    this.available.push(primary);

    for (let i = 1; i < this.maxSize; i++) {
      const conn = new Database(this.dbPath);
      this.setupConnection(conn);
      this.connections.push(conn);
      this.available.push(conn);
    }

    runMigrations(primary);
    this.initialized = true;
    logger.info({ poolSize: this.maxSize }, "Database connection pool initialized with WAL mode");
  }

  private setupConnection(conn: DatabaseType): void {
    conn.pragma("journal_mode = WAL");
    conn.pragma("synchronous = NORMAL");
    conn.pragma("foreign_keys = ON");
    conn.pragma("busy_timeout = 5000");
  }

  acquire(): DatabaseType {
    if (!this.initialized) {
      throw new Error("Connection pool not initialized");
    }
    if (this.available.length > 0) {
      return this.available.pop()!;
    }
    logger.warn("All database connections in use, reusing connection with busy timeout");
    return this.connections[0];
  }

  release(conn: DatabaseType): void {
    if (!this.connections.includes(conn)) {
      return;
    }
    if (!this.available.includes(conn)) {
      this.available.push(conn);
    }
  }

  close(): void {
    for (const conn of this.connections) {
      conn.close();
    }
    this.connections = [];
    this.available = [];
    this.initialized = false;
  }
}

let pool: ConnectionPool | null = null;

export function isDbInitialized(): boolean {
  return pool !== null;
}

export function initDb(path: string = DB_PATH, poolSize?: number): void {
  if (pool) {
    pool.close();
    pool = null;
  }

  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  pool = new ConnectionPool(path, poolSize ?? DEFAULT_POOL_SIZE);
  pool.initialize();
}

export function acquireConnection(): DatabaseType {
  if (!pool) {
    throw new Error("Database not initialized");
  }
  return pool.acquire();
}

export function releaseConnection(conn: DatabaseType): void {
  pool?.release(conn);
}

export function withConnection<T>(fn: (conn: DatabaseType) => T): T {
  const conn = acquireConnection();
  try {
    return fn(conn);
  } finally {
    releaseConnection(conn);
  }
}

export function closeDb(): void {
  pool?.close();
  pool = null;
}
