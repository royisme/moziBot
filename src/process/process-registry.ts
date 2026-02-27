import Database, { type Database as DatabaseType } from "better-sqlite3";
import path from "node:path";
import { logger } from "../logger";

export type ProcessStatus = "running" | "exited";

export type ProcessRecord = {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  status: ProcessStatus;
  exitCode: number | null;
  signal: string | null;
  backgrounded: boolean;
  pty: boolean;
  outputTail: string;
  sessionId?: string;
  agentId?: string;
  endedAt?: number;
  totalOutputChars: number;
};

export type ProcessSessionRecord = {
  id: string;
  sessionId: string;
  agentId: string;
  command: string;
  cwd: string;
  startedAt: number;
  status: ProcessStatus;
  exitCode: number | null;
  signal: string | null;
  backgrounded: boolean;
  pty: boolean;
  outputTail: string;
  endedAt?: number;
  totalOutputChars: number;
};

const OUTPUT_TAIL_MAX_LENGTH = 32 * 1024; // 32KB tail buffer
const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MIN_JOB_TTL_MS = 60 * 1000; // 1 minute
const MAX_JOB_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours

function clampTtl(value: number | undefined): number {
  if (!value || Number.isNaN(value)) {
    return DEFAULT_JOB_TTL_MS;
  }
  return Math.min(Math.max(value, MIN_JOB_TTL_MS), MAX_JOB_TTL_MS);
}

export class ProcessRegistry {
  private db: DatabaseType;
  private jobTtlMs: number;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(dbPath: string, jobTtlMs?: number) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.jobTtlMs = clampTtl(jobTtlMs);
    this.initSchema();
    this.startSweeper();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS process_sessions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        exit_code INTEGER,
        signal TEXT,
        backgrounded INTEGER NOT NULL DEFAULT 0,
        pty INTEGER NOT NULL DEFAULT 0,
        output_tail TEXT NOT NULL DEFAULT '',
        total_output_chars INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_process_sessions_session_id
      ON process_sessions(session_id)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_process_sessions_status
      ON process_sessions(status)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_process_sessions_started_at
      ON process_sessions(started_at)
    `);
  }

  addSession(params: {
    id: string;
    sessionId: string;
    agentId: string;
    command: string;
    cwd: string;
    backgrounded: boolean;
    pty: boolean;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO process_sessions (
        id, session_id, agent_id, command, cwd, started_at,
        status, backgrounded, pty, output_tail, total_output_chars
      ) VALUES (
        :id, :sessionId, :agentId, :command, :cwd, :startedAt,
        'running', :backgrounded, :pty, '', 0
      )
    `);

    stmt.run({
      id: params.id,
      sessionId: params.sessionId,
      agentId: params.agentId,
      command: params.command,
      cwd: params.cwd,
      startedAt: Date.now(),
      backgrounded: params.backgrounded ? 1 : 0,
      pty: params.pty ? 1 : 0,
    });
  }

  appendOutput(id: string, output: string): void {
    try {
      const existing = this.db.prepare("SELECT output_tail, total_output_chars FROM process_sessions WHERE id = ?").get(id) as
        | { output_tail: string; total_output_chars: number }
        | undefined;

      if (!existing) {
        return;
      }

      let newTail = existing.output_tail + output;
      const newTotalChars = existing.total_output_chars + output.length;
      if (newTail.length > OUTPUT_TAIL_MAX_LENGTH) {
        newTail = newTail.slice(-OUTPUT_TAIL_MAX_LENGTH);
      }

      this.db.prepare("UPDATE process_sessions SET output_tail = ?, total_output_chars = ? WHERE id = ?").run(newTail, newTotalChars, id);
    } catch {
      // Ignore if database is closed
    }
  }

  markExited(params: { id: string; exitCode: number | null; signal: string | null }): void {
    try {
      this.db
        .prepare("UPDATE process_sessions SET status = ?, exit_code = ?, signal = ?, ended_at = ? WHERE id = ?")
        .run("exited", params.exitCode, params.signal, Date.now(), params.id);
    } catch {
      // Ignore if database is closed
    }
  }

  getStatus(id: string): ProcessSessionRecord | null {
    const row = this.db.prepare("SELECT * FROM process_sessions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;

    if (!row) {
      return null;
    }

    return this.rowToRecord(row);
  }

  getRunningProcesses(sessionId: string): ProcessSessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM process_sessions WHERE session_id = ? AND status = 'running'")
      .all(sessionId) as Record<string, unknown>[];

    return rows.map((row) => this.rowToRecord(row));
  }

  getFinishedProcesses(sessionId: string): ProcessSessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM process_sessions WHERE session_id = ? AND status = 'exited'")
      .all(sessionId) as Record<string, unknown>[];

    return rows.map((row) => this.rowToRecord(row));
  }

  getAllProcesses(sessionId?: string): ProcessSessionRecord[] {
    if (sessionId) {
      const rows = this.db
        .prepare("SELECT * FROM process_sessions WHERE session_id = ?")
        .all(sessionId) as Record<string, unknown>[];
      return rows.map((row) => this.rowToRecord(row));
    }
    const rows = this.db
      .prepare("SELECT * FROM process_sessions")
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.rowToRecord(row));
  }

  tail(id: string, maxChars?: number): string | null {
    const row = this.db.prepare("SELECT output_tail FROM process_sessions WHERE id = ?").get(id) as
      | { output_tail: string }
      | undefined;

    if (!row) {
      return null;
    }

    if (maxChars !== undefined && row.output_tail.length > maxChars) {
      return row.output_tail.slice(-maxChars);
    }

    return row.output_tail;
  }

  kill(id: string): boolean {
    const row = this.db.prepare("SELECT status FROM process_sessions WHERE id = ?").get(id) as
      | { status: string }
      | undefined;

    if (!row || row.status !== "running") {
      return false;
    }

    return true;
  }

  markBackgrounded(id: string): void {
    this.db.prepare("UPDATE process_sessions SET backgrounded = 1 WHERE id = ?").run(id);
  }

  cleanupOldSessions(sessionId: string, maxAgeMs?: number): number {
    const ttl = maxAgeMs ?? this.jobTtlMs;
    const cutoff = Date.now() - ttl;
    // For exited sessions, use ended_at; for running sessions, use started_at
    const result = this.db
      .prepare(
        `DELETE FROM process_sessions 
         WHERE session_id = ? 
         AND status = 'exited' 
         AND (ended_at IS NOT NULL AND ended_at < ? OR ended_at IS NULL AND started_at < ?)`,
      )
      .run(sessionId, cutoff, cutoff);

    return result.changes;
  }

  cleanupAllOldSessions(maxAgeMs?: number): number {
    const ttl = maxAgeMs ?? this.jobTtlMs;
    const cutoff = Date.now() - ttl;
    // For exited sessions, use ended_at; for running sessions, use started_at
    const result = this.db
      .prepare(
        `DELETE FROM process_sessions 
         WHERE status = 'exited' 
         AND (ended_at IS NOT NULL AND ended_at < ? OR ended_at IS NULL AND started_at < ?)`,
      )
      .run(cutoff, cutoff);

    return result.changes;
  }

  close(): void {
    this.stopSweeper();
    this.db.close();
  }

  private rowToRecord(row: Record<string, unknown>): ProcessSessionRecord {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      agentId: row.agent_id as string,
      command: row.command as string,
      cwd: row.cwd as string,
      startedAt: row.started_at as number,
      status: row.status as ProcessStatus,
      exitCode: row.exit_code as number | null,
      signal: row.signal as string | null,
      backgrounded: (row.backgrounded as number) === 1,
      pty: (row.pty as number) === 1,
      outputTail: row.output_tail as string,
      endedAt: row.ended_at as number | undefined,
      totalOutputChars: row.total_output_chars as number,
    };
  }

  private pruneExpiredSessions(): void {
    const cutoff = Date.now() - this.jobTtlMs;
    this.db
      .prepare(
        "DELETE FROM process_sessions WHERE status = 'exited' AND started_at < ?",
      )
      .run(cutoff);
  }

  private startSweeper(): void {
    if (this.sweeper) {
      return;
    }
    const interval = Math.max(30_000, this.jobTtlMs / 6);
    this.sweeper = setInterval(() => this.pruneExpiredSessions(), interval);
    this.sweeper.unref?.();
  }

  private stopSweeper(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }
}

let globalRegistry: ProcessRegistry | null = null;

export function getProcessRegistry(dbPath?: string, jobTtlMs?: number): ProcessRegistry {
  if (!globalRegistry) {
    const defaultPath = path.join(process.cwd(), ".mozi", "data", "process-registry.db");
    globalRegistry = new ProcessRegistry(dbPath ?? defaultPath, jobTtlMs);
  }
  return globalRegistry;
}

export function setProcessRegistry(registry: ProcessRegistry): void {
  globalRegistry = registry;
}

export function closeProcessRegistry(): void {
  if (globalRegistry) {
    globalRegistry.close();
    globalRegistry = null;
  }
}
