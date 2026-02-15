import type { ReminderRecord } from "../types";
import { withConnection } from "../connection";

export const reminders = {
  create: (item: {
    id: string;
    sessionKey: string;
    channelId: string;
    peerId: string;
    peerType: string;
    message: string;
    scheduleKind: "at" | "every" | "cron";
    scheduleJson: string;
    nextRunAt: string | null;
  }) =>
    withConnection((conn) => {
      const now = new Date().toISOString();
      conn
        .prepare(
          `INSERT INTO reminders (id, session_key, channel_id, peer_id, peer_type, message, schedule_kind, schedule_json, enabled, next_run_at, last_run_at, cancelled_at, created_at, updated_at)
           VALUES ($id, $session_key, $channel_id, $peer_id, $peer_type, $message, $schedule_kind, $schedule_json, 1, $next_run_at, NULL, NULL, $created_at, $updated_at)`,
        )
        .run({
          id: item.id,
          session_key: item.sessionKey,
          channel_id: item.channelId,
          peer_id: item.peerId,
          peer_type: item.peerType,
          message: item.message,
          schedule_kind: item.scheduleKind,
          schedule_json: item.scheduleJson,
          next_run_at: item.nextRunAt,
          created_at: now,
          updated_at: now,
        });
    }),
  getById: (id: string): ReminderRecord | null =>
    withConnection(
      (conn) =>
        (conn.prepare(`SELECT * FROM reminders WHERE id = $id`).get({ id: id }) as
          | ReminderRecord
          | undefined) ?? null,
    ),
  listBySession: (
    sessionKey: string,
    opts?: {
      includeDisabled?: boolean;
      limit?: number;
    },
  ): ReminderRecord[] =>
    withConnection((conn) => {
      const includeDisabled = opts?.includeDisabled ?? false;
      const limit = Math.max(1, opts?.limit ?? 50);
      if (includeDisabled) {
        return conn
          .prepare(
            `SELECT * FROM reminders WHERE session_key = $session_key ORDER BY created_at DESC LIMIT $limit`,
          )
          .all({ session_key: sessionKey, limit }) as ReminderRecord[];
      }
      return conn
        .prepare(
          `SELECT * FROM reminders WHERE session_key = $session_key AND enabled = 1 ORDER BY created_at DESC LIMIT $limit`,
        )
        .all({ session_key: sessionKey, limit }) as ReminderRecord[];
    }),
  listDue: (nowIso: string, limit = 32): ReminderRecord[] =>
    withConnection(
      (conn) =>
        conn
          .prepare(
            `SELECT * FROM reminders WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= $now ORDER BY next_run_at ASC LIMIT $limit`,
          )
          .all({ now: nowIso, limit: Math.max(1, limit) }) as ReminderRecord[],
    ),
  markFired: (params: {
    id: string;
    expectedNextRunAt: string;
    firedAt: string;
    nextRunAt: string | null;
    enabled: boolean;
  }): boolean =>
    withConnection((conn) => {
      const result = conn
        .prepare(
          `UPDATE reminders SET last_run_at = $last_run_at, next_run_at = $next_run_at, enabled = $enabled, updated_at = $updated_at WHERE id = $id AND enabled = 1 AND next_run_at = $expected_next_run_at`,
        )
        .run({
          id: params.id,
          expected_next_run_at: params.expectedNextRunAt,
          last_run_at: params.firedAt,
          next_run_at: params.nextRunAt,
          enabled: params.enabled ? 1 : 0,
          updated_at: new Date().toISOString(),
        });
      return result.changes > 0;
    }),
  cancel: (id: string): boolean =>
    withConnection((conn) => {
      const now = new Date().toISOString();
      const result = conn
        .prepare(
          `UPDATE reminders SET enabled = 0, cancelled_at = $cancelled_at, updated_at = $updated_at WHERE id = $id AND enabled = 1`,
        )
        .run({
          id: id,
          cancelled_at: now,
          updated_at: now,
        });
      return result.changes > 0;
    }),
  cancelBySession: (id: string, sessionKey: string): boolean =>
    withConnection((conn) => {
      const now = new Date().toISOString();
      const result = conn
        .prepare(
          `UPDATE reminders SET enabled = 0, cancelled_at = $cancelled_at, updated_at = $updated_at WHERE id = $id AND session_key = $session_key AND enabled = 1`,
        )
        .run({
          id,
          session_key: sessionKey,
          cancelled_at: now,
          updated_at: now,
        });
      return result.changes > 0;
    }),
  updateBySession: (params: {
    id: string;
    sessionKey: string;
    message: string;
    scheduleKind: "at" | "every" | "cron";
    scheduleJson: string;
    nextRunAt: string | null;
  }): boolean =>
    withConnection((conn) => {
      const now = new Date().toISOString();
      const result = conn
        .prepare(
          `UPDATE reminders
             SET message = $message,
                 schedule_kind = $schedule_kind,
                 schedule_json = $schedule_json,
                 next_run_at = $next_run_at,
                 enabled = CASE WHEN $next_run_at IS NULL THEN 0 ELSE 1 END,
                 cancelled_at = CASE WHEN $next_run_at IS NULL THEN COALESCE(cancelled_at, $updated_at) ELSE NULL END,
                 updated_at = $updated_at
           WHERE id = $id AND session_key = $session_key`,
        )
        .run({
          id: params.id,
          session_key: params.sessionKey,
          message: params.message,
          schedule_kind: params.scheduleKind,
          schedule_json: params.scheduleJson,
          next_run_at: params.nextRunAt,
          updated_at: now,
        });
      return result.changes > 0;
    }),
  updateNextRunBySession: (params: {
    id: string;
    sessionKey: string;
    nextRunAt: string;
  }): boolean =>
    withConnection((conn) => {
      const now = new Date().toISOString();
      const result = conn
        .prepare(
          `UPDATE reminders
             SET next_run_at = $next_run_at,
                 enabled = 1,
                 cancelled_at = NULL,
                 updated_at = $updated_at
           WHERE id = $id AND session_key = $session_key`,
        )
        .run({
          id: params.id,
          session_key: params.sessionKey,
          next_run_at: params.nextRunAt,
          updated_at: now,
        });
      return result.changes > 0;
    }),
};
