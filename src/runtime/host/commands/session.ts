import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MoziConfig } from "../../../config";
import type { ChannelPlugin } from "../../adapters/channels/plugin";
import type { InboundMessage } from "../../adapters/channels/types";
import type { AgentManager } from "../../agent-manager";
import type { ReasoningLevel } from "../message-handler/types";
import { resolveMemoryBackendConfig } from "../../../memory/backend-config";

export async function handleWhoamiCommand(params: {
  message: InboundMessage;
  channel: ChannelPlugin;
  peerId: string;
}): Promise<void> {
  const { message, channel, peerId } = params;

  const lines = [
    "Identity information:",
    `  User ID: ${message.senderId}`,
    `  Username: ${message.senderName || "(unknown)"}`,
    `  Channel: ${message.channel}`,
    `  Chat ID: ${message.peerId}`,
    `  Chat type: ${message.peerType ?? "dm"}`,
  ];

  if (message.accountId) {
    lines.push(`  Account ID: ${message.accountId}`);
  }
  if (message.threadId) {
    lines.push(`  Thread ID: ${message.threadId}`);
  }

  await channel.send(peerId, { text: lines.join("\n") });
}

export async function handleStatusCommand(params: {
  sessionKey: string;
  agentId: string;
  message: InboundMessage;
  channel: ChannelPlugin;
  peerId: string;
  agentManager: AgentManager;
  runtimeControl?: {
    getStatus?: () => { running: boolean; pid: number | null; uptime: number };
  };
  resolveCurrentReasoningLevel: (sessionKey: string, agentId: string) => ReasoningLevel;
  version: string;
}): Promise<void> {
  const {
    sessionKey,
    agentId,
    message,
    channel,
    peerId,
    agentManager,
    runtimeControl,
    resolveCurrentReasoningLevel,
    version,
  } = params;
  const current = await agentManager.getAgent(sessionKey, agentId);
  const usage = agentManager.getContextUsage(sessionKey);
  const runtimeStatus = runtimeControl?.getStatus?.();
  const metadata = agentManager.getSessionMetadata(sessionKey) as
    | { thinkingLevel?: string; reasoningLevel?: ReasoningLevel }
    | undefined;
  const configuredThinking = agentManager.resolveConfiguredThinkingLevel(agentId);
  const effectiveThinking = metadata?.thinkingLevel ?? configuredThinking ?? "off";
  const effectiveReasoning = resolveCurrentReasoningLevel(sessionKey, agentId);

  const lines: string[] = [];

  lines.push(`🤖 Mozi ${version}`);

  lines.push(`🧠 Model: ${current.modelRef}`);
  lines.push(`🧭 Thinking: ${effectiveThinking}`);
  lines.push(`🪄 Reasoning: ${effectiveReasoning}`);

  if (usage) {
    lines.push(
      `📚 Context: ${formatTokens(usage.usedTokens)}/${formatTokens(usage.totalTokens)} (${usage.percentage}%) · 📝 ${usage.messageCount} messages`,
    );
  }

  lines.push(`🧵 Session: ${sessionKey}`);

  const runtimeMode = runtimeStatus
    ? `${runtimeStatus.running ? "running" : "stopped"} · pid=${runtimeStatus.pid ?? "n/a"} · uptime=${formatUptime(runtimeStatus.uptime)}`
    : "direct";
  lines.push(`⚙️ Runtime: ${runtimeMode}`);

  lines.push(
    `👤 User: ${message.senderId} · ${message.channel}:${message.peerType ?? "dm"}:${message.peerId}`,
  );

  await channel.send(peerId, { text: lines.join("\n") });
}

export async function handleNewSessionCommand(params: {
  sessionKey: string;
  agentId: string;
  channel: ChannelPlugin;
  peerId: string;
  config: MoziConfig;
  agentManager: AgentManager;
  flushMemory: (params: {
    sessionKey: string;
    agentId: string;
    messages: AgentMessage[];
    config: {
      enabled: boolean;
      onNewReset: boolean;
      onOverflowCompaction: boolean;
      maxMessages: number;
      maxChars: number;
      timeoutMs: number;
    };
  }) => Promise<boolean>;
}): Promise<void> {
  const { sessionKey, agentId, channel, peerId, config, agentManager, flushMemory } = params;
  const memoryConfig = resolveMemoryBackendConfig({ cfg: config, agentId });
  if (memoryConfig.persistence.enabled && memoryConfig.persistence.onNewReset) {
    const { agent } = await agentManager.getAgent(sessionKey, agentId);
    const success = await flushMemory({
      sessionKey,
      agentId,
      messages: agent.messages,
      config: memoryConfig.persistence,
    });
    agentManager.updateSessionMetadata(sessionKey, {
      memoryFlush: {
        lastAttemptedCycle: 0,
        lastTimestamp: Date.now(),
        lastStatus: success ? "success" : "failure",
        trigger: "new",
      },
    });
  }

  agentManager.resetSession(sessionKey, agentId);
  await channel.send(peerId, { text: "New session started (rotated to a new session segment)." });
}

export async function handleRestartCommand(params: {
  runtimeControl?: {
    restart?: () => Promise<void> | void;
  };
  channel: ChannelPlugin;
  peerId: string;
}): Promise<void> {
  const { runtimeControl, channel, peerId } = params;
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
  channel: ChannelPlugin;
  peerId: string;
  agentManager: AgentManager;
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

export async function handleContextCommand(params: {
  sessionKey: string;
  agentId: string;
  channel: ChannelPlugin;
  peerId: string;
  config: MoziConfig;
  agentManager: AgentManager;
}): Promise<void> {
  const { sessionKey, agentId, channel, peerId, config, agentManager } = params;

  const breakdown = agentManager.getContextBreakdown(sessionKey);
  if (!breakdown) {
    await channel.send(peerId, { text: "No active session." });
    return;
  }

  const usage = agentManager.getContextUsage(sessionKey);
  const lines = [
    "Context details:",
    `  System prompt: ${formatTokens(breakdown.systemPromptTokens)}`,
    `  User messages: ${formatTokens(breakdown.userMessageTokens)}`,
    `  Assistant messages: ${formatTokens(breakdown.assistantMessageTokens)}`,
    `  Tool results: ${formatTokens(breakdown.toolResultTokens)}`,
    `  ---`,
    `  Total: ${formatTokens(breakdown.totalTokens)}`,
  ];

  if (usage) {
    lines.push(`  Usage: ${usage.usedTokens}/${usage.totalTokens} (${usage.percentage}%)`);
  }

  const agents = (config.agents || {}) as Record<string, unknown>;
  const defaults = (agents.defaults as { contextPruning?: { enabled?: boolean } } | undefined)
    ?.contextPruning;
  const entry = (agents[agentId] as { contextPruning?: { enabled?: boolean } } | undefined)
    ?.contextPruning;
  const pruningEnabled = entry?.enabled ?? defaults?.enabled ?? true;
  const memoryConfig = resolveMemoryBackendConfig({ cfg: config, agentId });
  lines.push(`  Pruning: ${pruningEnabled ? "enabled" : "disabled"}`);
  lines.push(`  Memory persistence: ${memoryConfig.persistence.enabled ? "enabled" : "disabled"}`);
  if (memoryConfig.persistence.enabled) {
    lines.push(
      `  Pre-overflow flush: ${memoryConfig.persistence.onOverflowCompaction ? "enabled" : "disabled"}`,
    );
  }

  await channel.send(peerId, { text: lines.join("\n") });
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return `${tokens} tokens`;
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1000).toFixed(1)}K tokens`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}
