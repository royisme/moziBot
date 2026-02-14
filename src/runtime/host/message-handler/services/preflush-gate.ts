import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { resolveMemoryBackendConfig, type ResolvedMemoryPersistenceConfig } from "../../../../memory/backend-config";
import type { MoziConfig } from "../../../../config";

interface AgentManagerPreflushLike {
  getContextUsage(sessionKey: string): { percentage: number } | null;
  getAgent(sessionKey: string, agentId: string): Promise<{ agent: { messages: AgentMessage[] } }>;
  updateSessionMetadata(sessionKey: string, metadata: Record<string, unknown>): void;
}

export async function maybePreFlushBeforePrompt(params: {
  sessionKey: string;
  agentId: string;
  config: MoziConfig;
  agentManager: AgentManagerPreflushLike;
  flushMemory: (
    sessionKey: string,
    agentId: string,
    messages: AgentMessage[],
    config: ResolvedMemoryPersistenceConfig,
  ) => Promise<boolean>;
}): Promise<void> {
  const { sessionKey, agentId, config, agentManager, flushMemory } = params;
  const memoryConfig = resolveMemoryBackendConfig({ cfg: config, agentId });
  if (!memoryConfig.persistence.enabled || !memoryConfig.persistence.onOverflowCompaction) {
    return;
  }

  const usage = agentManager.getContextUsage(sessionKey);
  if (!usage || usage.percentage < 80) {
    return;
  }

  const { agent } = await agentManager.getAgent(sessionKey, agentId);
  const success = await flushMemory(sessionKey, agentId, agent.messages, memoryConfig.persistence);

  agentManager.updateSessionMetadata(sessionKey, {
    memoryFlush: {
      lastAttemptedCycle: 0,
      lastTimestamp: Date.now(),
      lastStatus: success ? "success" : "failure",
      trigger: "pre_overflow",
    },
  });
}
