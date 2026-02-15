import type { Database as DatabaseType } from "better-sqlite3";
import { logger } from "../logger";

export function runMigrations(conn: DatabaseType): void {
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
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      peer_type TEXT NOT NULL,
      message TEXT NOT NULL,
      schedule_kind TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT,
      last_run_at TEXT,
      cancelled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  conn.exec(`
    CREATE INDEX IF NOT EXISTS idx_reminders_due
    ON reminders(enabled, next_run_at);
  `);

  conn.exec(`
    CREATE INDEX IF NOT EXISTS idx_reminders_session
    ON reminders(session_key, created_at DESC);
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
