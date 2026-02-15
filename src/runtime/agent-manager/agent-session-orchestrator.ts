import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { MoziConfig } from "../../config";
import type { SandboxConfig } from "../sandbox/types";
import type { SessionStore } from "../session-store";
import {
  type AgentEntry,
  resolveHomeDir,
  resolveSandboxConfig,
  resolveWorkspaceDir,
} from "./config-resolver";

export async function resolveOrCreateAgentSession(params: {
  sessionKey: string;
  agentId?: string;
  config: MoziConfig;
  sessions: SessionStore;
  agents: Map<string, AgentSession>;
  agentModelRefs: Map<string, string>;
  runtimeModelOverrides: Map<string, string>;
  resolveDefaultAgentId: () => string;
  getAgentEntry: (agentId: string) => AgentEntry | undefined;
  resolveAgentModelRef: (agentId: string, entry?: AgentEntry) => string | undefined;
  setSessionModel: (
    sessionKey: string,
    modelRef: string,
    options?: { persist?: boolean },
  ) => Promise<void>;
  createAndInitializeAgentSession: (params: {
    sessionKey: string;
    resolvedId: string;
    modelRef: string;
    entry?: AgentEntry;
    workspaceDir: string;
    homeDir: string;
    sandboxConfig?: SandboxConfig;
  }) => Promise<AgentSession>;
}): Promise<{
  agent: AgentSession;
  resolvedId: string;
  entry?: AgentEntry;
  modelRef: string;
}> {
  const resolvedId = params.agentId || params.resolveDefaultAgentId();
  const entry = params.getAgentEntry(resolvedId);
  const workspaceDir = resolveWorkspaceDir(params.config, resolvedId, entry);
  const homeDir = resolveHomeDir(params.config, resolvedId, entry);
  const session = params.sessions.getOrCreate(params.sessionKey, resolvedId);

  const runtimeOverride = params.runtimeModelOverrides.get(params.sessionKey);
  const lockedModel = session.currentModel;
  const modelRef = runtimeOverride || lockedModel || params.resolveAgentModelRef(resolvedId, entry);
  if (!modelRef) {
    throw new Error(`No model configured for agent ${resolvedId}`);
  }

  let agent = params.agents.get(params.sessionKey);
  if (agent) {
    const activeModelRef = params.agentModelRefs.get(params.sessionKey);
    if (activeModelRef !== modelRef) {
      await params.setSessionModel(params.sessionKey, modelRef, { persist: false });
      agent = params.agents.get(params.sessionKey);
    }
  }

  if (!agent) {
    const sandboxConfig = resolveSandboxConfig(params.config, entry);
    agent = await params.createAndInitializeAgentSession({
      sessionKey: params.sessionKey,
      resolvedId,
      modelRef,
      entry,
      workspaceDir,
      homeDir,
      sandboxConfig,
    });
    params.agents.set(params.sessionKey, agent);
    params.agentModelRefs.set(params.sessionKey, modelRef);
  }

  return { agent, resolvedId, entry, modelRef };
}
