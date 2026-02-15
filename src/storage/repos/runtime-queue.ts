import { withConnection } from "../connection";
import type { RuntimeQueueItem } from "../types";

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
