import type { SessionStore } from "../../..";
import type { AgentManager } from "../../..";
import type { AssistantMessageShape } from "./reply-finalizer";

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

export function resolveSessionMessages(params: {
  sessionKey: string;
  sessions: SessionStore;
  agentManager: AgentManager;
  latestPromptMessages: Map<string, AssistantMessageShape[]>;
}): AssistantMessageShape[] {
  const { sessionKey, sessions, agentManager, latestPromptMessages } = params;
  const latest = latestPromptMessages.get(sessionKey);
  if (latest && latest.length > 0) {
    return latest;
  }
  const existing = sessions.get(sessionKey)?.context;
  if (Array.isArray(existing) && existing.length > 0) {
    return existing as AssistantMessageShape[];
  }
  const created = sessions.getOrCreate(sessionKey, agentManager.resolveDefaultAgentId()).context;
  return (created || []) as AssistantMessageShape[];
}
