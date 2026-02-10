import { EventEmitter } from "node:events";
import type { Session, SessionEvent, SessionFilters } from "./types";
import { logger } from "../../../logger";
import { sessions as dbSessions } from "../../../storage/db";

const VALID_SESSION_STATUSES: ReadonlySet<Session["status"]> = new Set([
  "idle",
  "queued",
  "running",
  "retrying",
  "completed",
  "failed",
  "interrupted",
]);

function normalizeSessionStatus(status: string | undefined): Session["status"] {
  if (status && VALID_SESSION_STATUSES.has(status as Session["status"])) {
    return status as Session["status"];
  }
  return "idle";
}

export class SessionManager extends EventEmitter {
  private sessions: Map<string, Session> = new Map();

  /**
   * Load persisted sessions from database
   */
  async load() {
    try {
      const records = dbSessions.list() as Array<{
        key: string;
        agent_id: string;
        channel: string;
        peer_id: string;
        peer_type: string;
        status: string;
        parent_key: string | null;
        metadata: string | null;
        created_at: string;
        last_active_at: string;
      }>;
      for (const record of records) {
        const session: Session = {
          key: record.key,
          agentId: record.agent_id,
          channel: record.channel,
          peerId: record.peer_id,
          peerType: record.peer_type as "dm" | "group",
          status: normalizeSessionStatus(record.status),
          parentKey: record.parent_key || undefined,
          metadata: record.metadata ? JSON.parse(record.metadata) : undefined,
          createdAt: new Date(record.created_at),
          lastActiveAt: new Date(record.last_active_at),
        };
        this.sessions.set(session.key, session);
      }
      logger.info(`Loaded ${this.sessions.size} sessions from database`);
    } catch (error) {
      logger.error("Failed to load sessions from database:", error);
    }
  }

  /**
   * Create or retrieve existing session
   */
  async getOrCreate(key: string, defaults: Partial<Session>): Promise<Session> {
    let session = this.sessions.get(key);
    if (session) {
      return session;
    }

    const parsed = SessionManager.parseKey(key);
    session = {
      key,
      agentId: (defaults.agentId as string) || parsed.agentId,
      channel: (defaults.channel as string) || parsed.channel,
      peerId: (defaults.peerId as string) || parsed.peerId,
      peerType: (defaults.peerType as "dm" | "group") || (parsed.type === "dm" ? "dm" : "group"),
      status: normalizeSessionStatus(defaults.status as string | undefined),
      createdAt: new Date(),
      lastActiveAt: new Date(),
      parentKey: defaults.parentKey,
      metadata: defaults.metadata,
    };

    this.sessions.set(key, session);
    dbSessions.create(session);

    this.emit("event", { type: "created", session } as SessionEvent);
    return session;
  }

  /**
   * Get session by key
   */
  get(key: string): Session | undefined {
    return this.sessions.get(key);
  }

  /**
   * List sessions with optional filters
   */
  list(filters?: SessionFilters): Session[] {
    let results = Array.from(this.sessions.values());

    if (filters) {
      if (filters.agentId) {
        results = results.filter((s) => s.agentId === filters.agentId);
      }
      if (filters.channel) {
        results = results.filter((s) => s.channel === filters.channel);
      }
      if (filters.status) {
        results = results.filter((s) => s.status === filters.status);
      }
      if (filters.parentKey) {
        results = results.filter((s) => s.parentKey === filters.parentKey);
      }
    }

    return results;
  }

  /**
   * Update session properties
   */
  async update(key: string, changes: Partial<Session>): Promise<Session | null> {
    const session = this.sessions.get(key);
    if (!session) {
      return null;
    }

    const updated = {
      ...session,
      ...changes,
      lastActiveAt: new Date(),
    };

    // Only pass actual changes to DB update to avoid overwriting everything
    const dbChanges: Record<string, unknown> = { ...changes, lastActiveAt: updated.lastActiveAt };

    this.sessions.set(key, updated);
    dbSessions.update(key, dbChanges);

    this.emit("event", {
      type: "updated",
      session: updated,
      changes,
    } as SessionEvent);
    return updated;
  }

  /**
   * Update status
   */
  async setStatus(key: string, status: Session["status"]): Promise<void> {
    await this.update(key, { status });
  }

  /**
   * Delete session
   */
  async delete(key: string): Promise<boolean> {
    if (this.sessions.has(key)) {
      this.sessions.delete(key);
      dbSessions.delete(key);
      this.emit("event", { type: "deleted", key } as SessionEvent);
      return true;
    }
    return false;
  }

  /**
   * Get children of a session (subagents)
   */
  getChildren(parentKey: string): Session[] {
    return this.list({ parentKey });
  }

  /**
   * Parse session key: {agentId}:{channel}:{type}:{peerId}
   */
  static parseKey(key: string): {
    agentId: string;
    channel: string;
    type: string;
    peerId: string;
  } {
    const [agentId, channel, type, peerId] = key.split(":");
    return {
      agentId: agentId || "mozi",
      channel: channel || "unknown",
      type: type || "dm",
      peerId: peerId || "unknown",
    };
  }

  /**
   * Build session key
   */
  static buildKey(agentId: string, channel: string, type: string, peerId: string): string {
    return `${agentId}:${channel}:${type}:${peerId}`;
  }
}
