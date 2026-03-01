import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { getAcpRuntimeBackend, requireAcpRuntimeBackend } from "../../../acp/runtime/registry";
import {
  listAcpSessionEntries,
  readAcpSessionEntry,
  upsertAcpSessionMeta,
} from "../../../acp/runtime/session-meta";
import { resolveSessionKey } from "../../../acp/session-key-utils";
import type { SessionAcpMeta } from "../../../acp/types";
import type { MoziConfig } from "../../../config";
import {
  isAcpDispatchEnabledByPolicy,
  isAcpEnabledByPolicy,
} from "../../../config/schema/acp-policy";
import { resolveMemoryBackendConfig } from "../../../memory/backend-config";
import type { ChannelPlugin } from "../../adapters/channels/plugin";
import type { InboundMessage } from "../../adapters/channels/types";
import type { AgentManager } from "../../agent-manager";
import type { ReasoningLevel } from "../../model/thinking";

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

  const promptMetadata =
    "getPromptMetadata" in agentManager ? agentManager.getPromptMetadata(sessionKey) : undefined;
  if (promptMetadata) {
    lines.push(`🧩 Prompt mode: ${promptMetadata.mode}`);
    lines.push(`🏠 Home: ${promptMetadata.homeDir}`);
    lines.push(`📁 Workspace: ${promptMetadata.workspaceDir}`);
    lines.push(`🧾 Prompt hash: ${promptMetadata.promptHash}`);
    if (promptMetadata.loadedFiles.length > 0) {
      lines.push(
        `📦 Loaded files: ${promptMetadata.loadedFiles.map((f) => `${f.name}(${f.chars})`).join(", ")}`,
      );
    }
    if (promptMetadata.skippedFiles.length > 0) {
      lines.push(
        `⏭️ Skipped files: ${promptMetadata.skippedFiles
          .map((f) => `${f.name}:${f.reason}`)
          .join(", ")}`,
      );
    }
  }

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

export async function handlePromptDigestCommand(params: {
  sessionKey: string;
  agentId: string;
  channel: ChannelPlugin;
  peerId: string;
  agentManager: AgentManager;
}): Promise<void> {
  const { sessionKey, channel, peerId, agentManager } = params;
  const promptMetadata = agentManager.getPromptMetadata(sessionKey);
  if (!promptMetadata) {
    await channel.send(peerId, { text: "No active session." });
    return;
  }

  const lines: string[] = [];
  lines.push("Prompt digest:");
  lines.push(`  Mode: ${promptMetadata.mode}`);
  lines.push(`  Hash: ${promptMetadata.promptHash}`);
  lines.push(`  Home: ${promptMetadata.homeDir}`);
  lines.push(`  Workspace: ${promptMetadata.workspaceDir}`);
  if (promptMetadata.loadedFiles.length > 0) {
    lines.push(
      `  Loaded files: ${promptMetadata.loadedFiles
        .map((f) => `${f.name}(${f.chars}, ${f.hash})`)
        .join(", ")}`,
    );
  }
  if (promptMetadata.skippedFiles.length > 0) {
    lines.push(
      `  Skipped files: ${promptMetadata.skippedFiles
        .map((f) => `${f.name}:${f.reason}`)
        .join(", ")}`,
    );
  }

  await channel.send(peerId, { text: lines.join("\n") });
}

export async function handleAcpCommand(params: {
  sessionKey: string;
  agentId: string;
  message: InboundMessage;
  channel: ChannelPlugin;
  peerId: string;
  args: string;
  config: MoziConfig;
}): Promise<void> {
  const { sessionKey, agentId, message, channel, peerId, args, config } = params;
  const raw = args.trim();
  if (!raw) {
    await channel.send(peerId, {
      text: [
        "ACP commands:",
        "  /acp spawn [backend] [--agent=<id>] [--mode=persistent|oneshot] [--cwd=<path>]",
        "  /acp status <sessionKeyOrLabel>",
        "  /acp cancel <sessionKeyOrLabel>",
        "  /acp list",
      ].join("\n"),
    });
    return;
  }

  const parsed = parseAcpSubcommand(raw);
  if (!parsed) {
    await channel.send(peerId, {
      text: `Unsupported /acp command: ${raw}. Use /acp for help.`,
    });
    return;
  }

  if (!isAcpEnabledByPolicy(config)) {
    await channel.send(peerId, { text: "ACP is disabled by policy (acp.enabled=false)." });
    return;
  }

  if (parsed.subcommand === "spawn") {
    await handleAcpSpawnFromRuntime({
      channel,
      peerId,
      agentId,
      sessionKey,
      message,
      config,
      backendInput: parsed.backend,
      modeInput: parsed.mode,
      cwdInput: parsed.cwd,
      agentInput: parsed.agent,
    });
    return;
  }

  if (parsed.subcommand === "list") {
    await handleAcpListFromRuntime({ channel, peerId });
    return;
  }

  if (parsed.subcommand === "status") {
    await handleAcpStatusFromRuntime({
      channel,
      peerId,
      keyOrLabel: parsed.target,
      config,
      json: parsed.json,
    });
    return;
  }

  if (parsed.subcommand === "cancel") {
    await handleAcpCancelFromRuntime({ channel, peerId, keyOrLabel: parsed.target, config });
    return;
  }

  await channel.send(peerId, {
    text: `Unsupported /acp command: ${raw}. Use /acp for help.`,
  });
}

type ParsedAcpSubcommand =
  | {
      subcommand: "spawn";
      backend?: string;
      agent?: string;
      mode?: string;
      cwd?: string;
    }
  | { subcommand: "status"; target: string; json: boolean }
  | { subcommand: "cancel"; target: string }
  | { subcommand: "list" };

function parseAcpSubcommand(input: string): ParsedAcpSubcommand | null {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }

  const sub = tokens[0]?.toLowerCase();
  if (sub === "list") {
    return { subcommand: "list" };
  }

  if (sub === "status") {
    const target = tokens[1]?.trim();
    if (!target) {
      return null;
    }
    const json = tokens.slice(2).some((token) => token === "--json");
    return { subcommand: "status", target, json };
  }

  if (sub === "cancel") {
    const target = tokens[1]?.trim();
    if (!target) {
      return null;
    }
    return { subcommand: "cancel", target };
  }

  if (sub === "spawn") {
    const optionTokens = tokens.slice(1);
    let backend: string | undefined;
    let agent: string | undefined;
    let mode: string | undefined;
    let cwd: string | undefined;

    for (const token of optionTokens) {
      if (token.startsWith("--agent=")) {
        agent = token.slice("--agent=".length).trim() || undefined;
        continue;
      }
      if (token.startsWith("--mode=")) {
        mode = token.slice("--mode=".length).trim() || undefined;
        continue;
      }
      if (token.startsWith("--cwd=")) {
        cwd = token.slice("--cwd=".length).trim() || undefined;
        continue;
      }
      if (!token.startsWith("-") && !backend) {
        backend = token;
      }
    }

    return { subcommand: "spawn", backend, agent, mode, cwd };
  }

  return null;
}

async function handleAcpSpawnFromRuntime(params: {
  channel: ChannelPlugin;
  peerId: string;
  agentId: string;
  sessionKey: string;
  message: InboundMessage;
  config: MoziConfig;
  backendInput?: string;
  modeInput?: string;
  cwdInput?: string;
  agentInput?: string;
}): Promise<void> {
  const {
    channel,
    peerId,
    agentId,
    sessionKey,
    config,
    backendInput,
    modeInput,
    cwdInput,
    agentInput,
  } = params;

  if (!isAcpDispatchEnabledByPolicy(config)) {
    await channel.send(peerId, {
      text: "ACP dispatch is disabled by policy (acp.dispatch.enabled=false).",
    });
    return;
  }

  const resolvedBackend = (backendInput ?? config.acp?.backend ?? "").trim();
  if (!resolvedBackend) {
    await channel.send(peerId, {
      text: "ACP backend is required. Use /acp spawn <backend> or set acp.backend in config.",
    });
    return;
  }

  const resolvedMode = (modeInput ?? "persistent").trim().toLowerCase();
  if (resolvedMode !== "persistent" && resolvedMode !== "oneshot") {
    await channel.send(peerId, {
      text: `Invalid ACP mode: ${modeInput}. Use persistent or oneshot.`,
    });
    return;
  }

  const resolvedAgent = (
    agentInput ??
    config.acp?.defaultAgent ??
    config.acp?.allowedAgents?.[0] ??
    agentId
  ).trim();
  if (!resolvedAgent) {
    await channel.send(peerId, { text: "Unable to resolve ACP agent." });
    return;
  }

  const existing = readAcpSessionEntry({ sessionKey });
  if (existing?.acp) {
    await channel.send(peerId, {
      text: `ACP session already exists for this chat: ${sessionKey}`,
    });
    return;
  }

  const cwd = (cwdInput ?? "").trim() || process.cwd();

  let runtimeBackend: ReturnType<typeof requireAcpRuntimeBackend>;
  try {
    runtimeBackend = requireAcpRuntimeBackend(resolvedBackend);
  } catch (error) {
    await channel.send(peerId, {
      text: `ACP backend unavailable: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  const now = Date.now();
  const meta: SessionAcpMeta = {
    backend: runtimeBackend.id,
    agent: resolvedAgent,
    runtimeSessionName: sessionKey,
    mode: resolvedMode,
    cwd,
    state: "idle",
    lastActivityAt: now,
  };

  try {
    const handle = await runtimeBackend.runtime.ensureSession({
      sessionKey,
      agent: resolvedAgent,
      mode: resolvedMode,
      cwd,
    });

    upsertAcpSessionMeta({
      sessionKey,
      mutate: () => ({
        ...meta,
        identity: {
          state: "resolved",
          acpxRecordId: handle.acpxRecordId,
          acpxSessionId: handle.backendSessionId,
          agentSessionId: handle.agentSessionId,
          source: "ensure",
          lastUpdatedAt: now,
        },
      }),
    });

    await channel.send(peerId, {
      text: [
        "ACP session spawned.",
        `sessionKey: ${sessionKey}`,
        `backend: ${runtimeBackend.id}`,
        `agent: ${resolvedAgent}`,
        `mode: ${resolvedMode}`,
      ].join("\n"),
    });
  } catch (error) {
    await channel.send(peerId, {
      text: `Failed to spawn ACP session: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function handleAcpListFromRuntime(params: {
  channel: ChannelPlugin;
  peerId: string;
}): Promise<void> {
  const { channel, peerId } = params;
  const sessions = listAcpSessionEntries();
  if (sessions.length === 0) {
    await channel.send(peerId, { text: "No ACP sessions found." });
    return;
  }

  const lines = ["ACP sessions:"];
  for (const session of sessions) {
    if (!session.acp) {
      continue;
    }
    lines.push(
      `- ${session.sessionKey} · backend=${session.acp.backend} · agent=${session.acp.agent} · state=${session.acp.state}`,
    );
  }

  await channel.send(peerId, { text: lines.join("\n") });
}

async function handleAcpStatusFromRuntime(params: {
  channel: ChannelPlugin;
  peerId: string;
  keyOrLabel: string;
  config: MoziConfig;
  json: boolean;
}): Promise<void> {
  const { channel, peerId, keyOrLabel, config, json } = params;

  const resolvedKey =
    (await resolveSessionKey({
      keyOrLabel,
      config,
    })) ?? keyOrLabel.trim();
  const entry = readAcpSessionEntry({ sessionKey: resolvedKey });
  const meta = entry?.acp;

  if (!meta) {
    await channel.send(peerId, { text: `ACP session not found: ${keyOrLabel}` });
    return;
  }

  if (json) {
    await channel.send(peerId, {
      text: JSON.stringify(
        {
          sessionKey: resolvedKey,
          backend: meta.backend,
          agent: meta.agent,
          state: meta.state,
          mode: meta.mode,
          runtimeSessionName: meta.runtimeSessionName,
          cwd: meta.cwd,
          identity: meta.identity,
          lastActivityAt: meta.lastActivityAt,
          lastError: meta.lastError,
        },
        null,
        2,
      ),
    });
    return;
  }

  const backend = getAcpRuntimeBackend(meta.backend);
  const lines = [
    "ACP session status:",
    `sessionKey: ${resolvedKey}`,
    `runtime: ${meta.runtimeSessionName}`,
    `backend: ${meta.backend}`,
    `agent: ${meta.agent}`,
    `state: ${meta.state}`,
    `mode: ${meta.mode}`,
    `cwd: ${meta.cwd ?? ""}`,
  ];

  if (meta.identity?.agentSessionId && backend?.runtime.getStatus) {
    try {
      const runtimeStatus = await backend.runtime.getStatus({
        handle: {
          sessionKey: resolvedKey,
          backend: meta.backend,
          runtimeSessionName: meta.runtimeSessionName,
          cwd: meta.cwd,
          backendSessionId: meta.identity.acpxSessionId,
          agentSessionId: meta.identity.agentSessionId,
        },
      });
      if (runtimeStatus?.summary) {
        lines.push(`runtimeStatus: ${runtimeStatus.summary}`);
      }
    } catch {
      // keep runtime status optional
    }
  }

  if (meta.lastError) {
    lines.push(`lastError: ${meta.lastError}`);
  }

  await channel.send(peerId, { text: lines.join("\n") });
}

async function handleAcpCancelFromRuntime(params: {
  channel: ChannelPlugin;
  peerId: string;
  keyOrLabel: string;
  config: MoziConfig;
}): Promise<void> {
  const { channel, peerId, keyOrLabel, config } = params;

  const resolvedKey =
    (await resolveSessionKey({
      keyOrLabel,
      config,
    })) ?? keyOrLabel.trim();
  const entry = readAcpSessionEntry({ sessionKey: resolvedKey });
  const meta = entry?.acp;

  if (!meta) {
    await channel.send(peerId, { text: `ACP session not found: ${keyOrLabel}` });
    return;
  }

  const backend = getAcpRuntimeBackend(meta.backend);
  if (!backend) {
    await channel.send(peerId, {
      text: `ACP backend not available: ${meta.backend}`,
    });
    return;
  }

  if (meta.state !== "running") {
    await channel.send(peerId, {
      text: `ACP session is not running (state=${meta.state}).`,
    });
    return;
  }

  try {
    if (meta.identity?.agentSessionId) {
      await backend.runtime.close({
        handle: {
          sessionKey: resolvedKey,
          backend: meta.backend,
          runtimeSessionName: meta.runtimeSessionName,
          cwd: meta.cwd,
          backendSessionId: meta.identity.acpxSessionId,
          agentSessionId: meta.identity.agentSessionId,
        },
        reason: "cancelled-by-user",
      });
    }

    upsertAcpSessionMeta({
      sessionKey: resolvedKey,
      mutate: (current) => {
        if (!current) {
          return null;
        }
        return {
          ...current,
          state: "idle",
          lastActivityAt: Date.now(),
        };
      },
    });

    await channel.send(peerId, { text: `ACP session cancelled: ${resolvedKey}` });
  } catch (error) {
    await channel.send(peerId, {
      text: `Failed to cancel ACP session: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
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
