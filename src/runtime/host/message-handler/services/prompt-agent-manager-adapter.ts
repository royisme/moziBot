import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentManager } from "../../..";
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
): PromptCoordinatorAgentManager {
  return agentManager as unknown as PromptCoordinatorAgentManager;
}
