import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MoziConfig } from "../../../../config";
import {
  resolveMemoryBackendConfig,
  type ResolvedMemoryPersistenceConfig,
} from "../../../../memory/backend-config";
import { getRuntimeHookRunner } from "../../../hooks";

interface SendChannel {
  send(peerId: string, payload: { text: string }): Promise<unknown>;
}

interface AgentManagerLike {
  getAgent(
    sessionKey: string,
    agentId: string,
    options?: { promptMode?: "main" | "reset-greeting" | "subagent-minimal" },
  ): Promise<{ agent: { messages: AgentMessage[] } }>;
  updateSessionMetadata(sessionKey: string, metadata: Record<string, unknown>): void;
  resetSession(sessionKey: string, agentId: string): void;
  compactSession(
    sessionKey: string,
    agentId: string,
  ): Promise<{ success: boolean; tokensReclaimed?: number; reason?: string }>;
}

export async function handleNewSessionCommand(params: {
  sessionKey: string;
  agentId: string;
  channel: SendChannel;
  peerId: string;
  config: MoziConfig;
  agentManager: AgentManagerLike;
  flushMemory: (
    sessionKey: string,
    agentId: string,
    messages: AgentMessage[],
    config: ResolvedMemoryPersistenceConfig,
  ) => Promise<boolean>;
  runResetGreetingTurn?: (params: {
    sessionKey: string;
    agentId: string;
    peerId: string;
  }) => Promise<string | null>;
}): Promise<void> {
  const {
    sessionKey,
    agentId,
    channel,
    peerId,
    config,
    agentManager,
    flushMemory,
    runResetGreetingTurn,
  } = params;
  const memoryConfig = resolveMemoryBackendConfig({ cfg: config, agentId });
  let snapshotMessages: AgentMessage[] | undefined;
  if (memoryConfig.persistence.enabled && memoryConfig.persistence.onNewReset) {
    const { agent } = await agentManager.getAgent(sessionKey, agentId);
    snapshotMessages = agent.messages;
    const success = await flushMemory(
      sessionKey,
      agentId,
      agent.messages,
      memoryConfig.persistence,
    );
    agentManager.updateSessionMetadata(sessionKey, {
      memoryFlush: {
        lastAttemptedCycle: 0,
        lastTimestamp: Date.now(),
        lastStatus: success ? "success" : "failure",
        trigger: "new",
      },
    });
  }

  const hookRunner = getRuntimeHookRunner();
  if (hookRunner.hasHooks("before_reset")) {
    if (!snapshotMessages) {
      const { agent } = await agentManager.getAgent(sessionKey, agentId);
      snapshotMessages = agent.messages;
    }
    await hookRunner.runBeforeReset(
      {
        reason: "new",
        messages: snapshotMessages ?? [],
      },
      {
        sessionKey,
        agentId,
      },
    );
  }

  agentManager.resetSession(sessionKey, agentId);

  if (runResetGreetingTurn) {
    const greeting = await runResetGreetingTurn({ sessionKey, agentId, peerId });
    if (greeting && greeting.trim()) {
      await channel.send(peerId, { text: greeting.trim() });
      return;
    }
  }

  await channel.send(peerId, { text: "New session started (rotated to a new session segment)." });
}

export async function handleRestartCommand(params: {
  channel: SendChannel;
  peerId: string;
  runtimeControl?: { restart?: () => void | Promise<void> };
}): Promise<void> {
  const { channel, peerId, runtimeControl } = params;
  if (!runtimeControl?.restart) {
    await channel.send(peerId, {
      text: "Current runtime mode does not support /restart. Please run 'mozi runtime restart' on the host.",
    });
    return;
  }
  await channel.send(peerId, { text: "Restarting runtime..." });
  await runtimeControl.restart();
}

export async function handleCompactCommand(params: {
  sessionKey: string;
  agentId: string;
  channel: SendChannel;
  peerId: string;
  agentManager: AgentManagerLike;
}): Promise<void> {
  const { sessionKey, agentId, channel, peerId, agentManager } = params;
  await channel.send(peerId, { text: "Compacting session..." });

  const result = await agentManager.compactSession(sessionKey, agentId);
  if (result.success) {
    await channel.send(peerId, {
      text: `Session compacted, freed approximately ${result.tokensReclaimed} tokens.`,
    });
  } else {
    await channel.send(peerId, {
      text: `Compaction failed: ${result.reason || "Unknown error"}`,
    });
  }
}
