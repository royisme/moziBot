import type { SessionStore } from "../../..";
import type { AgentManager } from "../../..";

export function resolveSessionTimestamps(params: {
  sessionKey: string;
  sessions: SessionStore;
  agentManager: AgentManager;
}): { createdAt: number; updatedAt?: number } {
  const { sessionKey, sessions, agentManager } = params;
  const session =
    sessions.get(sessionKey) ||
    sessions.getOrCreate(sessionKey, agentManager.resolveDefaultAgentId());
  const now = Date.now();
  return {
    createdAt: session?.createdAt ?? now,
    updatedAt: session?.updatedAt,
  };
}

export function resolveSessionMetadata(params: {
  sessionKey: string;
  sessions: SessionStore;
  agentManager: AgentManager;
}): Record<string, unknown> {
  const { sessionKey, sessions, agentManager } = params;
  const fromAgentManager = agentManager.getSessionMetadata(sessionKey);
  if (fromAgentManager && Object.keys(fromAgentManager).length > 0) {
    return fromAgentManager;
  }
  const fromSessionStore = sessions.get(sessionKey)?.metadata;
  if (fromSessionStore && Object.keys(fromSessionStore).length > 0) {
    return fromSessionStore;
  }
  const fromSessionStoreCreated = sessions.getOrCreate(
    sessionKey,
    agentManager.resolveDefaultAgentId(),
  ).metadata;
  return fromSessionStoreCreated || {};
}
