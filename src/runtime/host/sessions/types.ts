import type { RuntimeQueueStatus } from "../../core/contracts";

export interface Session {
  key: string; // Unique: {agentId}:{channel}:{type}:{peerId}
  agentId: string;
  channel: string;
  peerId: string;
  peerType: "dm" | "group";
  status: "idle" | RuntimeQueueStatus;
  createdAt: Date;
  lastActiveAt: Date;
  parentKey?: string; // For subagents
  metadata?: Record<string, unknown>;
}

export interface SessionFilters {
  agentId?: string;
  channel?: string;
  status?: Session["status"];
  parentKey?: string;
}

export type SessionEvent =
  | { type: "created"; session: Session }
  | { type: "updated"; session: Session; changes: Partial<Session> }
  | { type: "deleted"; key: string };
