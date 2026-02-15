import { withConnection } from "../connection";

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
