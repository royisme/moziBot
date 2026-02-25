import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentManager } from "../../..";
import type { PromptMode } from "../../../agent-manager/prompt-builder";
import type { PromptAgent } from "./prompt-runner";

export type PromptCoordinatorAgentManager = {
  getAgent(
    sessionKey: string,
    agentId: string,
  ): Promise<{
    agent: PromptAgent & { messages: AgentMessage[] };
    modelRef: string;
  }>;
  getAgentFallbacks(agentId: string): string[];
  setSessionModel(
    sessionKey: string,
    modelRef: string,
    options: { persist: boolean },
  ): Promise<void>;
  clearRuntimeModelOverride(sessionKey: string): void;
  resolvePromptTimeoutMs(agentId: string): number;
  getSessionMetadata(sessionKey: string): Record<string, unknown> | undefined;
  updateSessionMetadata(sessionKey: string, metadata: Record<string, unknown>): void;
  compactSession(
    sessionKey: string,
    agentId: string,
  ): Promise<{ success: boolean; tokensReclaimed?: number; reason?: string }>;
  updateSessionContext(sessionKey: string, messages: AgentMessage[]): void;
  getContextUsage(sessionKey: string): {
    usedTokens: number;
    totalTokens: number;
    percentage: number;
  } | null;
};

export function toPromptCoordinatorAgentManager(
  agentManager: AgentManager,
  promptMode?: PromptMode,
): PromptCoordinatorAgentManager {
  return {
    getAgent: async (sessionKey, agentId) => {
      const resolved = await agentManager.getAgent(sessionKey, agentId, {
        promptMode,
      });
      return { agent: resolved.agent, modelRef: resolved.modelRef };
    },
    getAgentFallbacks: (agentId) => agentManager.getAgentFallbacks(agentId),
    setSessionModel: async (sessionKey, modelRef, options) =>
      await agentManager.setSessionModel(sessionKey, modelRef, options),
    clearRuntimeModelOverride: (sessionKey) => agentManager.clearRuntimeModelOverride(sessionKey),
    resolvePromptTimeoutMs: (agentId) => agentManager.resolvePromptTimeoutMs(agentId),
    getSessionMetadata: (sessionKey) => agentManager.getSessionMetadata(sessionKey),
    updateSessionMetadata: (sessionKey, metadata) =>
      agentManager.updateSessionMetadata(sessionKey, metadata),
    compactSession: async (sessionKey, agentId) =>
      await agentManager.compactSession(sessionKey, agentId),
    updateSessionContext: (sessionKey, messages) =>
      agentManager.updateSessionContext(sessionKey, messages),
    getContextUsage: (sessionKey) => agentManager.getContextUsage(sessionKey),
  };
}
