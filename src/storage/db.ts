import Database, { type Database as DatabaseType } from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../logger";

const DB_PATH = "data/mozi.db";
const DEFAULT_POOL_SIZE = 4;

export interface Message {
  id: string;
  channel: string;
  chat_id: string;
  sender_id: string;
  content: string;
  timestamp: string;
  created_at?: string;
}

export interface Group {
  id: string;
  channel: string;
  chat_id: string;
  name: string;
  folder: string;
  is_main: number;
  created_at?: string;
}

export interface Task {
  id: string;
  group_id: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  status: string;
  last_run: string | null;
  next_run: string | null;
  created_at?: string;
}

export type RuntimeQueueStatus =
  | "queued"
  | "running"
  | "retrying"
  | "completed"
  | "failed"
  | "interrupted";

export interface RuntimeQueueItem {
  id: string;
  dedup_key: string;
  session_key: string;
  channel_id: string;
  peer_id: string;
  peer_type: string;
  inbound_json: string;
  status: RuntimeQueueStatus;
  attempts: number;
  error: string | null;
  enqueued_at: string;
  available_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface AuthSecret {
  name: string;
  scope_type: "global" | "agent";
  scope_id: string;
  value_ciphertext: Buffer;
  value_nonce: Buffer;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  created_by: string | null;
}

export interface MultimodalMessage {
  id: string;
  protocol_version: string;
  tenant_id: string;
  conversation_id: string;
  message_id: string;
  direction: "inbound" | "outbound";
  source_channel: string;
  source_channel_message_id: string;
  source_user_id: string;
  correlation_id: string;
  trace_id: string;
  created_at: string;
}

export interface MultimodalMessagePart {
  id: string;
  message_id: string;
  idx: number;
  role: string;
  modality: string;
  text: string | null;
  media_id: string | null;
  metadata_json: string | null;
  created_at: string;
}

export interface MultimodalMediaAsset {
  id: string;
  tenant_id: string;
  sha256: string;
  mime_type: string;
  byte_size: number;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  filename: string | null;
  blob_uri: string;
  scan_status: string;
  created_at: string;
}

export interface MultimodalDeliveryAttempt {
  id: string;
  message_id: string;
  channel: string;
  attempt_no: number;
  status: string;
  error_code: string | null;
  error_detail: string | null;
  sent_at: string;
}

export interface MultimodalCapabilitySnapshot {
  id: string;
  message_id: string;
  channel_profile_json: string;
  provider_profile_json: string;
  policy_profile_json: string;
  plan_json: string;
  created_at: string;
}

export interface MultimodalRawEvent {
  id: string;
  channel: string;
  event_id: string;
  payload_json: string;
  received_at: string;
}

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

    this.runMigrations(primary);
    this.initialized = true;
    logger.info({ poolSize: this.maxSize }, "Database connection pool initialized with WAL mode");
  }

  private setupConnection(conn: DatabaseType): void {
    conn.pragma("journal_mode = WAL");
    conn.pragma("synchronous = NORMAL");
    conn.pragma("foreign_keys = ON");
    conn.pragma("busy_timeout = 5000");
  }

  private runMigrations(conn: DatabaseType): void {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    conn.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        name TEXT NOT NULL,
        folder TEXT NOT NULL UNIQUE,
        is_main INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    conn.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        schedule_value TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        last_run TEXT,
        next_run TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (group_id) REFERENCES groups(id)
      );
    `);

    conn.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        peer_type TEXT NOT NULL,
        status TEXT DEFAULT 'idle',
        parent_key TEXT,
        metadata TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_active_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    conn.exec(`
      CREATE TABLE IF NOT EXISTS runtime_queue (
        id TEXT PRIMARY KEY,
        dedup_key TEXT NOT NULL UNIQUE,
        session_key TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        peer_type TEXT NOT NULL,
        inbound_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        enqueued_at TEXT NOT NULL,
        available_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    conn.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtime_queue_status_available
      ON runtime_queue(status, available_at);
    `);

    conn.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtime_queue_session_status
      ON runtime_queue(session_key, status);
    `);

    conn.exec(`
      CREATE TABLE IF NOT EXISTS auth_secrets (
        name TEXT NOT NULL,
        scope_type TEXT NOT NULL DEFAULT 'global',
        scope_id TEXT NOT NULL DEFAULT '',
        value_ciphertext BLOB NOT NULL,
        value_nonce BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        created_by TEXT,
        PRIMARY KEY (scope_type, scope_id, name)
      );
    `);

    conn.exec(`
      CREATE INDEX IF NOT EXISTS idx_auth_secrets_scope_name
      ON auth_secrets(scope_type, scope_id, name);
    `);

    conn.exec(`
      CREATE TABLE IF NOT EXISTS multimodal_messages (
        id TEXT PRIMARY KEY,
        protocol_version TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        source_channel TEXT NOT NULL,
        source_channel_message_id TEXT NOT NULL,
        source_user_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    conn.exec(`
      CREATE TABLE IF NOT EXISTS multimodal_message_parts (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        role TEXT NOT NULL,
        modality TEXT NOT NULL,
        text TEXT,
        media_id TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES multimodal_messages(id) ON DELETE CASCADE,
        FOREIGN KEY (media_id) REFERENCES multimodal_media_assets(id)
      );
    `);

    conn.exec(`
      CREATE TABLE IF NOT EXISTS multimodal_media_assets (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        sha256 TEXT NOT NULL UNIQUE,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        duration_ms INTEGER,
        width INTEGER,
        height INTEGER,
        filename TEXT,
        blob_uri TEXT NOT NULL,
        scan_status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
    `);

    conn.exec(`
      CREATE TABLE IF NOT EXISTS multimodal_media_variants (
        id TEXT PRIMARY KEY,
        media_id TEXT NOT NULL,
        variant_kind TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        blob_uri TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (media_id) REFERENCES multimodal_media_assets(id) ON DELETE CASCADE
      );
    `);

    conn.exec(`
      CREATE TABLE IF NOT EXISTS multimodal_capability_snapshots (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        channel_profile_json TEXT NOT NULL,
        provider_profile_json TEXT NOT NULL,
        policy_profile_json TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES multimodal_messages(id) ON DELETE CASCADE
      );
    `);

    conn.exec(`
      CREATE TABLE IF NOT EXISTS multimodal_delivery_attempts (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        error_detail TEXT,
        sent_at TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES multimodal_messages(id) ON DELETE CASCADE
      );
    `);

    conn.exec(`
      CREATE TABLE IF NOT EXISTS multimodal_raw_events (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        event_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        UNIQUE(channel, event_id)
      );
    `);

    conn.exec(`
      CREATE INDEX IF NOT EXISTS idx_multimodal_messages_conversation_created
      ON multimodal_messages(conversation_id, created_at);
    `);

    conn.exec(`
      CREATE INDEX IF NOT EXISTS idx_multimodal_message_parts_message_idx
      ON multimodal_message_parts(message_id, idx);
    `);

    conn.exec(`
      CREATE INDEX IF NOT EXISTS idx_multimodal_delivery_attempts_message_attempt
      ON multimodal_delivery_attempts(message_id, attempt_no);
    `);

    logger.info("Database migrations completed");
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
  // Close existing pool before creating a new one (important for tests)
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

export const sessions = {
  create: (session: {
    key: string;
    agentId: string;
    channel: string;
    peerId: string;
    peerType: string;
    status: string;
    parentKey?: string;
    metadata?: unknown;
    createdAt: Date;
    lastActiveAt: Date;
  }) => {
    return withConnection((conn) => {
      conn
        .prepare(
          `INSERT INTO sessions (key, agent_id, channel, peer_id, peer_type, status, parent_key, metadata, created_at, last_active_at) VALUES ($key, $agent_id, $channel, $peer_id, $peer_type, $status, $parent_key, $metadata, $created_at, $last_active_at)`,
        )
        .run({
          key: session.key,
          agent_id: session.agentId,
          channel: session.channel,
          peer_id: session.peerId,
          peer_type: session.peerType,
          status: session.status,
          parent_key: session.parentKey || null,
          metadata: session.metadata ? JSON.stringify(session.metadata) : null,
          created_at: session.createdAt.toISOString(),
          last_active_at: session.lastActiveAt.toISOString(),
        });
    });
  },
  getByKey: (key: string) =>
    withConnection((conn) => conn.prepare("SELECT * FROM sessions WHERE key = ?").get(key)),
  list: () => withConnection((conn) => conn.prepare("SELECT * FROM sessions").all()),
  update: (key: string, changes: Record<string, unknown>) => {
    return withConnection((conn) => {
      const keys = Object.keys(changes);
      if (keys.length === 0) {
        return;
      }
      const mapping: Record<string, string> = {
        agentId: "agent_id",
        channel: "channel",
        peerId: "peer_id",
        peerType: "peer_type",
        status: "status",
        parentKey: "parent_key",
        metadata: "metadata",
        createdAt: "created_at",
        lastActiveAt: "last_active_at",
      };
      const sets = keys.map((k) => `${mapping[k] || k} = $${k}`).join(", ");
      const params: Record<string, unknown> = { key: key };
      for (const [k, value] of Object.entries(changes)) {
        let val = value;
        if (k === "metadata" && val) {
          val = JSON.stringify(val);
        }
        if ((k === "createdAt" || k === "lastActiveAt") && val instanceof Date) {
          val = val.toISOString();
        }
        params[k] = val ?? null;
      }
      conn
        .prepare(`UPDATE sessions SET ${sets} WHERE key = $key`)
        .run(params as Record<string, string | number | null>);
    });
  },
  delete: (key: string) =>
    withConnection((conn) => conn.prepare("DELETE FROM sessions WHERE key = ?").run(key)),
};

export const runtimeQueue = {
  enqueue: (item: {
    id: string;
    dedupKey: string;
    sessionKey: string;
    channelId: string;
    peerId: string;
    peerType: string;
    inboundJson: string;
    enqueuedAt: string;
    availableAt: string;
  }): { inserted: boolean } => {
    return withConnection((conn) => {
      const result = conn
        .prepare(
          `INSERT OR IGNORE INTO runtime_queue (id, dedup_key, session_key, channel_id, peer_id, peer_type, inbound_json, status, attempts, error, enqueued_at, available_at, started_at, finished_at, updated_at) VALUES ($id, $dedup_key, $session_key, $channel_id, $peer_id, $peer_type, $inbound_json, 'queued', 0, NULL, $enqueued_at, $available_at, NULL, NULL, $updated_at)`,
        )
        .run({
          id: item.id,
          dedup_key: item.dedupKey,
          session_key: item.sessionKey,
          channel_id: item.channelId,
          peer_id: item.peerId,
          peer_type: item.peerType,
          inbound_json: item.inboundJson,
          enqueued_at: item.enqueuedAt,
          available_at: item.availableAt,
          updated_at: item.enqueuedAt,
        });
      return { inserted: result.changes > 0 };
    });
  },
  findLatestQueuedBySessionSince: (sessionKey: string, since: string): RuntimeQueueItem | null => {
    return withConnection((conn) => {
      const row = conn
        .prepare(
          `SELECT * FROM runtime_queue WHERE session_key = $session_key AND status = 'queued' AND enqueued_at >= $since ORDER BY enqueued_at DESC LIMIT 1`,
        )
        .get({ session_key: sessionKey, since: since });
      return (row as RuntimeQueueItem | undefined) ?? null;
    });
  },
  mergeQueuedInbound: (id: string, inboundJson: string, availableAt: string): boolean => {
    return withConnection((conn) => {
      const result = conn
        .prepare(
          `UPDATE runtime_queue SET inbound_json = $inbound_json, available_at = $available_at, updated_at = $updated_at WHERE id = $id AND status = 'queued'`,
        )
        .run({
          id: id,
          inbound_json: inboundJson,
          available_at: availableAt,
          updated_at: new Date().toISOString(),
        });
      return result.changes > 0;
    });
  },
  listRunnable: (limit = 32): RuntimeQueueItem[] => {
    return withConnection(
      (conn) =>
        conn
          .prepare(
            `SELECT * FROM runtime_queue WHERE status IN ('queued', 'retrying') AND available_at <= $now ORDER BY enqueued_at ASC LIMIT $limit`,
          )
          .all({
            now: new Date().toISOString(),
            limit: limit,
          }) as RuntimeQueueItem[],
    );
  },
  claim: (id: string): boolean => {
    return withConnection((conn) => {
      const now = new Date().toISOString();
      const result = conn
        .prepare(
          `UPDATE runtime_queue SET status = 'running', started_at = $started_at, updated_at = $updated_at WHERE id = $id AND status IN ('queued', 'retrying')`,
        )
        .run({ id: id, started_at: now, updated_at: now });
      return result.changes > 0;
    });
  },
  markCompleted: (id: string) =>
    withConnection((conn) =>
      conn
        .prepare(
          `UPDATE runtime_queue SET status = 'completed', finished_at = $now, updated_at = $now WHERE id = $id`,
        )
        .run({ id: id, now: new Date().toISOString() }),
    ),
  markCompletedIfRunning: (id: string): boolean => {
    return withConnection(
      (conn) =>
        conn
          .prepare(
            `UPDATE runtime_queue SET status = 'completed', finished_at = $now, updated_at = $now WHERE id = $id AND status = 'running'`,
          )
          .run({ id: id, now: new Date().toISOString() }).changes > 0,
    );
  },
  markFailed: (id: string, error: string) =>
    withConnection((conn) =>
      conn
        .prepare(
          `UPDATE runtime_queue SET status = 'failed', error = $error, finished_at = $now, updated_at = $now WHERE id = $id`,
        )
        .run({ id: id, error: error, now: new Date().toISOString() }),
    ),
  markFailedIfRunning: (id: string, error: string): boolean => {
    return withConnection(
      (conn) =>
        conn
          .prepare(
            `UPDATE runtime_queue SET status = 'failed', error = $error, finished_at = $now, updated_at = $now WHERE id = $id AND status = 'running'`,
          )
          .run({ id: id, error: error, now: new Date().toISOString() }).changes > 0,
    );
  },
  markRetrying: (id: string, error: string, nextAvailableAt: string) => {
    return withConnection((conn) =>
      conn
        .prepare(
          `UPDATE runtime_queue SET status = 'retrying', attempts = attempts + 1, error = $error, available_at = $available_at, updated_at = $updated_at WHERE id = $id`,
        )
        .run({
          id: id,
          error: error,
          available_at: nextAvailableAt,
          updated_at: new Date().toISOString(),
        }),
    );
  },
  markRetryingIfRunning: (id: string, error: string, nextAvailableAt: string): boolean => {
    return withConnection(
      (conn) =>
        conn
          .prepare(
            `UPDATE runtime_queue SET status = 'retrying', attempts = attempts + 1, error = $error, available_at = $available_at, updated_at = $updated_at WHERE id = $id AND status = 'running'`,
          )
          .run({
            id: id,
            error: error,
            available_at: nextAvailableAt,
            updated_at: new Date().toISOString(),
          }).changes > 0,
    );
  },
  listPendingBySession: (sessionKey: string): RuntimeQueueItem[] => {
    return withConnection(
      (conn) =>
        conn
          .prepare(
            `SELECT * FROM runtime_queue WHERE session_key = $session_key AND status IN ('queued', 'retrying') ORDER BY enqueued_at ASC`,
          )
          .all({ session_key: sessionKey }) as RuntimeQueueItem[],
    );
  },
  markInterruptedBySession: (sessionKey: string, reason: string): number => {
    return withConnection((conn) => {
      const now = new Date().toISOString();
      return conn
        .prepare(
          `UPDATE runtime_queue SET status = 'interrupted', error = COALESCE(error, $reason), finished_at = COALESCE(finished_at, $now), updated_at = $now WHERE session_key = $session_key AND status IN ('queued', 'retrying', 'running')`,
        )
        .run({
          session_key: sessionKey,
          reason: reason,
          now: now,
        }).changes;
    });
  },
  markInterruptedByIds: (ids: string[], reason: string): number => {
    if (ids.length === 0) {
      return 0;
    }
    return withConnection((conn) => {
      const now = new Date().toISOString();
      const placeholders = ids.map((_, i) => `$id_${i}`).join(", ");
      const params: Record<string, string> = { reason: reason, now: now };
      for (const [i, id] of ids.entries()) {
        params[`id_${i}`] = id;
      }
      return conn
        .prepare(
          `UPDATE runtime_queue SET status = 'interrupted', error = COALESCE(error, $reason), finished_at = COALESCE(finished_at, $now), updated_at = $now WHERE id IN (${placeholders}) AND status IN ('queued', 'retrying', 'running')`,
        )
        .run(params).changes;
    });
  },
  markInterruptedFromRunning: (): number => {
    return withConnection(
      (conn) =>
        conn
          .prepare(
            `UPDATE runtime_queue SET status = 'interrupted', error = COALESCE(error, 'Runtime stopped while processing'), finished_at = COALESCE(finished_at, $finished_at), updated_at = $updated_at WHERE status = 'running'`,
          )
          .run({
            finished_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).changes,
    );
  },
  countPending: (): number =>
    withConnection(
      (conn) =>
        (
          conn
            .prepare(
              `SELECT COUNT(*) AS count FROM runtime_queue WHERE status IN ('queued', 'retrying')`,
            )
            .get() as { count: number }
        ).count,
    ),
  countPendingBySession: (sessionKey: string): number =>
    withConnection(
      (conn) =>
        (
          conn
            .prepare(
              `SELECT COUNT(*) AS count FROM runtime_queue WHERE session_key = $session_key AND status IN ('queued', 'retrying', 'running')`,
            )
            .get({ session_key: sessionKey }) as { count: number }
        ).count,
    ),
  getById: (id: string): RuntimeQueueItem | null =>
    withConnection(
      (conn) =>
        (conn.prepare(`SELECT * FROM runtime_queue WHERE id = $id`).get({ id: id }) as
          | RuntimeQueueItem
          | undefined) ?? null,
    ),
};

export const authSecrets = {
  upsert: (secret: {
    name: string;
    scopeType: "global" | "agent";
    scopeId?: string;
    valueCiphertext: Buffer;
    valueNonce: Buffer;
    createdBy?: string;
  }) => {
    return withConnection((conn) => {
      const now = new Date().toISOString();
      conn
        .prepare(
          `INSERT INTO auth_secrets (name, scope_type, scope_id, value_ciphertext, value_nonce, created_at, updated_at, last_used_at, created_by)
           VALUES ($name, $scope_type, $scope_id, $value_ciphertext, $value_nonce, $created_at, $updated_at, NULL, $created_by)
           ON CONFLICT(scope_type, scope_id, name)
           DO UPDATE SET value_ciphertext = excluded.value_ciphertext, value_nonce = excluded.value_nonce, updated_at = excluded.updated_at, created_by = excluded.created_by`,
        )
        .run({
          name: secret.name,
          scope_type: secret.scopeType,
          scope_id: secret.scopeId ?? "",
          value_ciphertext: secret.valueCiphertext,
          value_nonce: secret.valueNonce,
          created_at: now,
          updated_at: now,
          created_by: secret.createdBy ?? null,
        });
    });
  },
  delete: (params: { name: string; scopeType: "global" | "agent"; scopeId?: string }): boolean => {
    return withConnection(
      (conn) =>
        conn
          .prepare(
            `DELETE FROM auth_secrets WHERE name = $name AND scope_type = $scope_type AND scope_id = $scope_id`,
          )
          .run({
            name: params.name,
            scope_type: params.scopeType,
            scope_id: params.scopeId ?? "",
          }).changes > 0,
    );
  },
  list: (params?: { scopeType?: "global" | "agent"; scopeId?: string }): AuthSecret[] => {
    return withConnection((conn) => {
      if (!params?.scopeType) {
        return conn
          .prepare(`SELECT * FROM auth_secrets ORDER BY scope_type ASC, scope_id ASC, name ASC`)
          .all() as AuthSecret[];
      }
      return conn
        .prepare(
          `SELECT * FROM auth_secrets WHERE scope_type = $scope_type AND scope_id = $scope_id ORDER BY name ASC`,
        )
        .all({
          scope_type: params.scopeType,
          scope_id: params.scopeId ?? "",
        }) as AuthSecret[];
    });
  },
  getExact: (params: {
    name: string;
    scopeType: "global" | "agent";
    scopeId?: string;
  }): AuthSecret | null => {
    return withConnection(
      (conn) =>
        (conn
          .prepare(
            `SELECT * FROM auth_secrets WHERE name = $name AND scope_type = $scope_type AND scope_id = $scope_id`,
          )
          .get({
            name: params.name,
            scope_type: params.scopeType,
            scope_id: params.scopeId ?? "",
          }) as AuthSecret | undefined) ?? null,
    );
  },
  getEffective: (params: { name: string; agentId: string }): AuthSecret | null => {
    return withConnection((conn) => {
      const agentScoped = conn
        .prepare(
          `SELECT * FROM auth_secrets WHERE name = $name AND scope_type = 'agent' AND scope_id = $scope_id LIMIT 1`,
        )
        .get({ name: params.name, scope_id: params.agentId }) as AuthSecret | undefined;
      if (agentScoped) {
        return agentScoped;
      }
      return (
        (conn
          .prepare(
            `SELECT * FROM auth_secrets WHERE name = $name AND scope_type = 'global' AND scope_id = '' LIMIT 1`,
          )
          .get({ name: params.name }) as AuthSecret | undefined) ?? null
      );
    });
  },
  touchLastUsed: (params: { name: string; scopeType: "global" | "agent"; scopeId?: string }) => {
    return withConnection((conn) => {
      const now = new Date().toISOString();
      conn
        .prepare(
          `UPDATE auth_secrets SET last_used_at = $last_used_at, updated_at = $updated_at WHERE name = $name AND scope_type = $scope_type AND scope_id = $scope_id`,
        )
        .run({
          last_used_at: now,
          updated_at: now,
          name: params.name,
          scope_type: params.scopeType,
          scope_id: params.scopeId ?? "",
        });
    });
  },
};

export const messages = {
  create: (msg: Message) =>
    withConnection((conn) =>
      conn
        .prepare(
          `INSERT INTO messages (id, channel, chat_id, sender_id, content, timestamp) VALUES ($id, $channel, $chat_id, $sender_id, $content, $timestamp)`,
        )
        .run({
          id: msg.id,
          channel: msg.channel,
          chat_id: msg.chat_id,
          sender_id: msg.sender_id,
          content: msg.content,
          timestamp: msg.timestamp,
        }),
    ),
  getById: (id: string): Message | null =>
    withConnection(
      (conn) => conn.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Message | null,
    ),
  listByChat: (chatId: string): Message[] =>
    withConnection(
      (conn) =>
        conn
          .prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC")
          .all(chatId) as Message[],
    ),
};

export const groups = {
  create: (group: Group) =>
    withConnection((conn) =>
      conn
        .prepare(
          `INSERT INTO groups (id, channel, chat_id, name, folder, is_main) VALUES ($id, $channel, $chat_id, $name, $folder, $is_main)`,
        )
        .run({
          id: group.id,
          channel: group.channel,
          chat_id: group.chat_id,
          name: group.name,
          folder: group.folder,
          is_main: group.is_main,
        }),
    ),
  getById: (id: string): Group | null =>
    withConnection(
      (conn) => conn.prepare("SELECT * FROM groups WHERE id = ?").get(id) as Group | null,
    ),
  getByFolder: (folder: string): Group | null =>
    withConnection(
      (conn) => conn.prepare("SELECT * FROM groups WHERE folder = ?").get(folder) as Group | null,
    ),
  list: (): Group[] =>
    withConnection((conn) => conn.prepare("SELECT * FROM groups").all() as Group[]),
  update: (id: string, group: Partial<Omit<Group, "id">>) =>
    withConnection((conn) => {
      const keys = Object.keys(group);
      if (keys.length === 0) {
        return;
      }
      const sets = keys.map((k) => `${k} = $${k}`).join(", ");
      const params: Record<string, string | number | null> = { id: id };
      for (const [k, v] of Object.entries(group)) {
        params[k] = (v as string | number | null) ?? null;
      }
      conn.prepare(`UPDATE groups SET ${sets} WHERE id = $id`).run(params);
    }),
  delete: (id: string) =>
    withConnection((conn) => conn.prepare("DELETE FROM groups WHERE id = ?").run(id)),
};

export const tasks = {
  create: (task: Task) =>
    withConnection((conn) =>
      conn
        .prepare(
          `INSERT INTO tasks (id, group_id, prompt, schedule_type, schedule_value, status, last_run, next_run) VALUES ($id, $group_id, $prompt, $schedule_type, $schedule_value, $status, $last_run, $next_run)`,
        )
        .run({
          id: task.id,
          group_id: task.group_id,
          prompt: task.prompt,
          schedule_type: task.schedule_type,
          schedule_value: task.schedule_value,
          status: task.status,
          last_run: task.last_run,
          next_run: task.next_run,
        }),
    ),
  getById: (id: string): Task | null =>
    withConnection(
      (conn) =>
        (conn.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined) ?? null,
    ),
  listByGroup: (groupId: string): Task[] =>
    withConnection(
      (conn) => conn.prepare("SELECT * FROM tasks WHERE group_id = ?").all(groupId) as Task[],
    ),
  update: (id: string, task: Partial<Omit<Task, "id">>) =>
    withConnection((conn) => {
      const keys = Object.keys(task);
      if (keys.length === 0) {
        return;
      }
      const sets = keys.map((k) => `${k} = $${k}`).join(", ");
      const params: Record<string, string | number | null> = { id: id };
      for (const [k, v] of Object.entries(task)) {
        params[k] = (v as string | number | null) ?? null;
      }
      conn.prepare(`UPDATE tasks SET ${sets} WHERE id = $id`).run(params);
    }),
  delete: (id: string) =>
    withConnection((conn) => conn.prepare("DELETE FROM tasks WHERE id = ?").run(id)),
};

export const multimodal = {
  createMessage: (message: MultimodalMessage) =>
    withConnection((conn) =>
      conn
        .prepare(
          `INSERT INTO multimodal_messages (id, protocol_version, tenant_id, conversation_id, message_id, direction, source_channel, source_channel_message_id, source_user_id, correlation_id, trace_id, created_at) VALUES ($id, $protocol_version, $tenant_id, $conversation_id, $message_id, $direction, $source_channel, $source_channel_message_id, $source_user_id, $correlation_id, $trace_id, $created_at)`,
        )
        .run(message),
    ),
  createMessageParts: (
    parts: Array<Omit<MultimodalMessagePart, "created_at"> & { created_at?: string }>,
  ) =>
    withConnection((conn) => {
      const stmt = conn.prepare(
        `INSERT INTO multimodal_message_parts (id, message_id, idx, role, modality, text, media_id, metadata_json, created_at) VALUES ($id, $message_id, $idx, $role, $modality, $text, $media_id, $metadata_json, $created_at)`,
      );
      const now = new Date().toISOString();
      for (const part of parts) {
        stmt.run({
          ...part,
          created_at: part.created_at ?? now,
        });
      }
    }),
  upsertMediaAsset: (asset: MultimodalMediaAsset) =>
    withConnection((conn) =>
      conn
        .prepare(
          `INSERT INTO multimodal_media_assets (id, tenant_id, sha256, mime_type, byte_size, duration_ms, width, height, filename, blob_uri, scan_status, created_at) VALUES ($id, $tenant_id, $sha256, $mime_type, $byte_size, $duration_ms, $width, $height, $filename, $blob_uri, $scan_status, $created_at) ON CONFLICT(sha256) DO UPDATE SET mime_type = excluded.mime_type, byte_size = excluded.byte_size, duration_ms = excluded.duration_ms, width = excluded.width, height = excluded.height, filename = excluded.filename, blob_uri = excluded.blob_uri, scan_status = excluded.scan_status`,
        )
        .run(asset),
    ),
  createDeliveryAttempt: (attempt: MultimodalDeliveryAttempt) =>
    withConnection((conn) =>
      conn
        .prepare(
          `INSERT INTO multimodal_delivery_attempts (id, message_id, channel, attempt_no, status, error_code, error_detail, sent_at) VALUES ($id, $message_id, $channel, $attempt_no, $status, $error_code, $error_detail, $sent_at)`,
        )
        .run(attempt),
    ),
  createCapabilitySnapshot: (snapshot: MultimodalCapabilitySnapshot) =>
    withConnection((conn) =>
      conn
        .prepare(
          `INSERT INTO multimodal_capability_snapshots (id, message_id, channel_profile_json, provider_profile_json, policy_profile_json, plan_json, created_at) VALUES ($id, $message_id, $channel_profile_json, $provider_profile_json, $policy_profile_json, $plan_json, $created_at)`,
        )
        .run(snapshot),
    ),
  upsertRawEvent: (event: MultimodalRawEvent) =>
    withConnection((conn) =>
      conn
        .prepare(
          `INSERT INTO multimodal_raw_events (id, channel, event_id, payload_json, received_at) VALUES ($id, $channel, $event_id, $payload_json, $received_at) ON CONFLICT(channel, event_id) DO UPDATE SET payload_json = excluded.payload_json, received_at = excluded.received_at`,
        )
        .run(event),
    ),
};
