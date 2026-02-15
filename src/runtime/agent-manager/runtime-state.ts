import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { SessionStore } from "../session-store";

export function clearRuntimeModelOverride(params: {
  sessionKey: string;
  runtimeModelOverrides: Map<string, string>;
}): void {
  params.runtimeModelOverrides.delete(params.sessionKey);
}

export function disposeRuntimeSession(params: {
  sessionKey: string;
  agents: Map<string, AgentSession>;
  agentModelRefs: Map<string, string>;
  runtimeModelOverrides: Map<string, string>;
  channelContextSessions: Set<string>;
}): void {
  const { sessionKey, agents, agentModelRefs, runtimeModelOverrides, channelContextSessions } = params;
  const session = agents.get(sessionKey);
  if (session) {
    session.dispose();
  }
  agents.delete(sessionKey);
  agentModelRefs.delete(sessionKey);
  runtimeModelOverrides.delete(sessionKey);
  channelContextSessions.delete(sessionKey);
}

export function resetSession(params: {
  sessionKey: string;
  agentId?: string;
  sessions: SessionStore;
  resolveDefaultAgentId: () => string;
  disposeRuntimeSession: (sessionKey: string) => void;
}): void {
  const resolvedAgentId = params.agentId || params.resolveDefaultAgentId();
  params.sessions.rotateSegment(params.sessionKey, resolvedAgentId);
  params.disposeRuntimeSession(params.sessionKey);
}

export function disposeAllRuntimeSessions(params: {
  agents: Map<string, AgentSession>;
  agentModelRefs: Map<string, string>;
  runtimeModelOverrides: Map<string, string>;
  channelContextSessions: Set<string>;
}): void {
  for (const session of params.agents.values()) {
    session.dispose();
  }
  params.agents.clear();
  params.agentModelRefs.clear();
  params.runtimeModelOverrides.clear();
  params.channelContextSessions.clear();
}
