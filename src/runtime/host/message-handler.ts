import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { MoziConfig } from "../../config";
import type { DeliveryPlan } from "../../multimodal/capabilities";
import type { ChannelPlugin } from "../adapters/channels/plugin";
import type { InboundMessage, OutboundMessage } from "../adapters/channels/types";
import type { SecretScope } from "../auth/types";
import type { Schedule } from "./cron/types";
import type { SessionManager } from "./sessions/manager";
import { AgentManager, ModelRegistry, ProviderRegistry, SessionStore } from "..";
import { logger } from "../../logger";
import { getMemoryLifecycleOrchestrator } from "../../memory";
import {
  resolveHomeDir,
  resolveMemoryBackendConfig,
  type ResolvedMemoryPersistenceConfig,
} from "../../memory/backend-config";
import { FlushManager, type FlushMetadata } from "../../memory/flush-manager";
import { ingestInboundMessage } from "../../multimodal/ingest";
import { planOutboundByNegotiation } from "../../multimodal/outbound";
import { buildProviderInputPayload } from "../../multimodal/provider-payload";
import { reminders } from "../../storage/db";
import { createRuntimeSecretBroker } from "../auth/broker";
import {
  isContextOverflowError,
  isCompactionFailureError,
  estimateMessagesTokens,
} from "../context-management";
import { SubagentRegistry } from "../subagent-registry";
import { computeNextRun } from "./reminders/schedule";
import {
  getAssistantFailureReason,
  isSilentReplyText,
  renderAssistantReply,
  type ReplyRenderOptions,
} from "./reply-utils";
import { RuntimeRouter } from "./router";
import { buildSessionKey } from "./session-key";
import { SubAgentRegistry as SessionSubAgentRegistry } from "./sessions/spawn";
import { SttService } from "./stt-service";
import { createSessionTools } from "./tools/sessions";

/**
 * Callback interface for streaming agent responses to channels.
 * Called during agent execution to deliver real-time updates.
 */
export type StreamingCallback = (event: {
  type: "text_delta" | "tool_start" | "tool_end" | "agent_end";
  delta?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  fullText?: string;
}) => void | Promise<void>;

class StreamingBuffer {
  private static readonly FLUSH_INTERVAL_MS = 500;
  private static readonly MIN_CHARS_TO_FLUSH = 50;

  private buffer = "";
  private lastFlushTime = Date.now();
  private messageId: string | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private channel: ChannelPlugin,
    private peerId: string,
    private onError: (err: Error) => void,
  ) {}

  async initialize(): Promise<void> {
    this.messageId = await this.channel.send(this.peerId, { text: "⏳" });
  }

  append(text: string): void {
    this.buffer += text;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }

    const timeSinceFlush = Date.now() - this.lastFlushTime;
    const shouldFlushNow =
      this.buffer.length >= StreamingBuffer.MIN_CHARS_TO_FLUSH &&
      timeSinceFlush >= StreamingBuffer.FLUSH_INTERVAL_MS;

    if (shouldFlushNow) {
      void this.flush();
    } else {
      const delay = Math.max(0, StreamingBuffer.FLUSH_INTERVAL_MS - timeSinceFlush);
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, delay);
    }
  }

  private async flush(): Promise<void> {
    if (!this.messageId || !this.buffer || !this.channel.editMessage) {
      return;
    }

    const textToSend = this.buffer;
    this.lastFlushTime = Date.now();

    try {
      await this.channel.editMessage(this.messageId, this.peerId, textToSend);
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async finalize(finalText: string): Promise<string | null> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (!this.messageId) {
      return null;
    }

    const text = finalText || this.buffer || "(no response)";
    if (this.channel.editMessage) {
      try {
        await this.channel.editMessage(this.messageId, this.peerId, text);
      } catch (err) {
        this.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }

    return this.messageId;
  }

  getAccumulatedText(): string {
    return this.buffer;
  }
}

type LastRoute = {
  channelId: string;
  peerId: string;
  peerType: "dm" | "group" | "channel";
  accountId?: string;
  threadId?: string | number;
};

type LifecycleTemporalPolicy = {
  enabled?: boolean;
  activeWindowHours?: number;
  dayBoundaryRollover?: boolean;
};

type LifecycleConfig = {
  temporal?: LifecycleTemporalPolicy;
  semantic?: {
    enabled?: boolean;
    threshold?: number;
    debounceSeconds?: number;
    reversible?: boolean;
  };
};

type ResolvedSessionContext = {
  agentId: string;
  sessionKey: string;
  dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  peerId: string;
};

type RuntimeControl = {
  getStatus?: () => { running: boolean; pid: number | null; uptime: number };
  restart?: () => Promise<void> | void;
};

type ActivePromptAgent = {
  prompt: (text: string) => Promise<void> | void;
  abort?: () => Promise<void> | void;
  steer?: (message: string) => Promise<void> | void;
  followUp?: (message: string) => Promise<void> | void;
  subscribe?: (listener: (event: AgentSessionEvent) => void) => () => void;
};

export class MessageHandler {
  private static readonly PROMPT_PROGRESS_LOG_INTERVAL_MS = 30_000;
  private static readonly PROMPT_EXECUTION_TIMEOUT_MS = 60_000;
  private static readonly INTERRUPT_WAIT_TIMEOUT_MS = 5_000;
  private static readonly MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3;
  private sessions: SessionStore;
  private providerRegistry: ProviderRegistry;
  private modelRegistry: ModelRegistry;
  private agentManager: AgentManager;
  private subagents: SubagentRegistry;
  private router: RuntimeRouter;
  private lastRoutes = new Map<string, LastRoute>();
  private activePromptRuns = new Map<
    string,
    {
      agentId: string;
      modelRef: string;
      startedAt: number;
      agent: ActivePromptAgent;
    }
  >();
  private interruptedPromptRuns = new Set<string>();
  private config: MoziConfig;
  private runtimeControl?: RuntimeControl;
  private sttService: SttService;
  private secretBroker = createRuntimeSecretBroker();

  getAgentManager(): AgentManager {
    return this.agentManager;
  }

  async initExtensions(): Promise<void> {
    await this.agentManager.initExtensionsAsync();
  }

  async shutdownExtensions(): Promise<void> {
    await this.agentManager.shutdownExtensions();
  }

  constructor(
    config: MoziConfig,
    deps?: {
      sessionManager?: SessionManager;
      subAgentRegistry?: SessionSubAgentRegistry;
      runtimeControl?: RuntimeControl;
    },
  ) {
    this.config = config;
    this.runtimeControl = deps?.runtimeControl;
    this.sttService = new SttService(config);
    this.sessions = new SessionStore(config);
    this.router = new RuntimeRouter(config);
    this.providerRegistry = new ProviderRegistry(config);
    this.modelRegistry = new ModelRegistry(config);
    this.agentManager = new AgentManager({
      config,
      modelRegistry: this.modelRegistry,
      providerRegistry: this.providerRegistry,
      sessions: this.sessions,
    });
    this.subagents = new SubagentRegistry(
      this.modelRegistry,
      this.providerRegistry,
      this.agentManager,
    );
    this.agentManager.setSubagentRegistry(this.subagents);
    if (deps?.sessionManager && deps?.subAgentRegistry) {
      this.agentManager.setToolProvider((params) =>
        createSessionTools({
          sessionManager: deps.sessionManager!,
          subAgentRegistry: deps.subAgentRegistry!,
          currentSessionKey: params.sessionKey,
        }),
      );
    }
  }

  /**
   * Hot-reload configuration without losing agent state
   */
  async reloadConfig(config: MoziConfig): Promise<void> {
    this.config = config;
    this.sttService.updateConfig(config);
    this.router = new RuntimeRouter(config);
    this.providerRegistry = new ProviderRegistry(config);
    this.modelRegistry = new ModelRegistry(config);
    await this.agentManager.reloadConfig({
      config,
      modelRegistry: this.modelRegistry,
      providerRegistry: this.providerRegistry,
    });
    this.subagents = new SubagentRegistry(
      this.modelRegistry,
      this.providerRegistry,
      this.agentManager,
    );
    this.agentManager.setSubagentRegistry(this.subagents);
    logger.info("MessageHandler config reloaded (agents preserved)");
  }

  private getText(message: InboundMessage): string {
    return (message.text || "").toString();
  }

  private resolveReplyRenderOptions(agentId: string): ReplyRenderOptions {
    const agents = (this.config.agents || {}) as Record<string, unknown>;
    const defaults =
      (agents.defaults as { output?: ReplyRenderOptions } | undefined)?.output || undefined;
    const entry =
      (agents[agentId] as { output?: ReplyRenderOptions } | undefined)?.output || undefined;
    return {
      showThinking: entry?.showThinking ?? defaults?.showThinking ?? false,
      showToolCalls: entry?.showToolCalls ?? defaults?.showToolCalls ?? "off",
    };
  }

  private resolveTemporalLifecyclePolicy(agentId: string): Required<LifecycleTemporalPolicy> {
    const agents = (this.config.agents || {}) as Record<string, unknown>;
    const defaults = (agents.defaults as { lifecycle?: LifecycleConfig } | undefined)?.lifecycle
      ?.temporal;
    const entry = (agents[agentId] as { lifecycle?: LifecycleConfig } | undefined)?.lifecycle
      ?.temporal;

    return {
      enabled: entry?.enabled ?? defaults?.enabled ?? true,
      activeWindowHours: entry?.activeWindowHours ?? defaults?.activeWindowHours ?? 12,
      dayBoundaryRollover: entry?.dayBoundaryRollover ?? defaults?.dayBoundaryRollover ?? true,
    };
  }

  private shouldRotateSessionForTemporalPolicy(params: {
    sessionKey: string;
    agentId: string;
    nowMs?: number;
  }): boolean {
    const { sessionKey, agentId, nowMs = Date.now() } = params;
    const policy = this.resolveTemporalLifecyclePolicy(agentId);
    if (!policy.enabled) {
      return false;
    }

    const session = this.sessions.getOrCreate(sessionKey, agentId);
    const lastActivityMs = session.updatedAt || session.createdAt || nowMs;
    const activeWindowMs = Math.max(1, policy.activeWindowHours) * 60 * 60 * 1000;

    if (nowMs - lastActivityMs > activeWindowMs) {
      return true;
    }

    if (policy.dayBoundaryRollover && !this.isSameLocalDay(lastActivityMs, nowMs)) {
      return true;
    }

    return false;
  }

  private isSameLocalDay(aMs: number, bMs: number): boolean {
    const a = new Date(aMs);
    const b = new Date(bMs);
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  private resolveSemanticLifecyclePolicy(agentId: string): {
    enabled: boolean;
    threshold: number;
    debounceSeconds: number;
    reversible: boolean;
  } {
    const agents = (this.config.agents || {}) as Record<string, unknown>;
    const defaults =
      ((agents.defaults as { lifecycle?: LifecycleConfig } | undefined)?.lifecycle?.semantic as
        | { enabled?: boolean; threshold?: number; debounceSeconds?: number; reversible?: boolean }
        | undefined) || undefined;
    const entry =
      ((agents[agentId] as { lifecycle?: LifecycleConfig } | undefined)?.lifecycle?.semantic as
        | { enabled?: boolean; threshold?: number; debounceSeconds?: number; reversible?: boolean }
        | undefined) || undefined;

    return {
      enabled: entry?.enabled ?? defaults?.enabled ?? false,
      threshold: entry?.threshold ?? defaults?.threshold ?? 0.8,
      debounceSeconds: entry?.debounceSeconds ?? defaults?.debounceSeconds ?? 60,
      reversible: entry?.reversible ?? defaults?.reversible ?? true,
    };
  }

  private extractLastUserTextFromContext(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i] as { role?: string; content?: unknown };
      if (msg?.role !== "user") {
        continue;
      }
      const text = this.extractTextFromContent(msg.content);
      if (text.trim().length > 0) {
        return text;
      }
    }
    return "";
  }

  private extractTextFromContent(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          const maybe = part as { type?: string; text?: string; content?: string };
          if (typeof maybe?.text === "string") {
            return maybe.text;
          }
          if (maybe?.type === "text" && typeof maybe?.content === "string") {
            return maybe.content;
          }
          return "";
        })
        .join(" ");
    }
    return "";
  }

  private tokenizeTopic(text: string): Set<string> {
    const words = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3)
      .filter((w) => !new Set(["the", "and", "for", "with", "that", "this", "you", "are"]).has(w));
    return new Set(words);
  }

  private estimateSemanticShiftConfidence(prevText: string, nextText: string): number {
    if (!prevText.trim()) {
      return 0;
    }
    const prev = this.tokenizeTopic(prevText);
    const next = this.tokenizeTopic(nextText);
    if (prev.size === 0 || next.size === 0) {
      return 0;
    }

    let intersection = 0;
    for (const token of prev) {
      if (next.has(token)) {
        intersection += 1;
      }
    }
    const union = new Set([...prev, ...next]).size;
    const similarity = union > 0 ? intersection / union : 0;
    let confidence = 1 - similarity;
    const explicitShiftPattern = /^(new\s+topic|switch\s+topic|换个话题|另外一个问题)\b/i;
    if (explicitShiftPattern.test(nextText.trim())) {
      confidence = Math.min(1, confidence + 0.2);
    }
    return Number(confidence.toFixed(4));
  }

  private evaluateSemanticLifecycle(params: {
    sessionKey: string;
    agentId: string;
    text: string;
    nowMs?: number;
  }): {
    shouldRotate: boolean;
    shouldRevert: boolean;
    confidence: number;
    threshold: number;
    controlModelRef?: string;
  } {
    const { sessionKey, agentId, text, nowMs = Date.now() } = params;
    const policy = this.resolveSemanticLifecyclePolicy(agentId);
    if (!policy.enabled) {
      return {
        shouldRotate: false,
        shouldRevert: false,
        confidence: 0,
        threshold: policy.threshold,
      };
    }

    let controlModelRef: string | undefined;
    try {
      controlModelRef = this.agentManager.resolveLifecycleControlModel({
        sessionKey,
        agentId,
      }).modelRef;
    } catch {
      controlModelRef = undefined;
    }

    const session = this.sessions.getOrCreate(sessionKey, agentId);
    const lifecycleMeta =
      (session.metadata?.lifecycle as Record<string, unknown> | undefined) || {};
    const semanticMeta =
      (lifecycleMeta.semantic as
        | {
            lastRotationAt?: number;
            lastTrigger?: string;
            lastConfidence?: number;
            lastRotationType?: string;
          }
        | undefined) || undefined;

    const previousUserText = this.extractLastUserTextFromContext(
      Array.isArray(session.context) ? session.context : [],
    );
    const confidence = this.estimateSemanticShiftConfidence(previousUserText, text);

    const lastRotationAt = semanticMeta?.lastRotationAt ?? 0;
    if (policy.debounceSeconds > 0 && nowMs - lastRotationAt < policy.debounceSeconds * 1000) {
      const canRevert =
        policy.reversible &&
        semanticMeta?.lastRotationType === "semantic" &&
        confidence < Math.max(0.15, policy.threshold * 0.5);
      return {
        shouldRotate: false,
        shouldRevert: canRevert,
        confidence,
        threshold: policy.threshold,
        controlModelRef,
      };
    }

    return {
      shouldRotate: confidence >= policy.threshold,
      shouldRevert: false,
      confidence,
      threshold: policy.threshold,
      controlModelRef,
    };
  }

  private async handleModelsCommand(
    sessionKey: string,
    agentId: string,
    channel: ChannelPlugin,
    peerId: string,
  ): Promise<void> {
    const current = await this.agentManager.getAgent(sessionKey, agentId);
    const refs = this.modelRegistry
      .list()
      .map((spec) => `${spec.provider}/${spec.id}`)
      .toSorted();
    if (refs.length === 0) {
      await channel.send(peerId, {
        text: "No models available. Please add models.providers to the configuration.",
      });
      return;
    }
    const lines = ["Available models:"];
    for (const ref of refs) {
      if (ref === current.modelRef) {
        lines.push(`- ${ref} (current)`);
      } else {
        lines.push(`- ${ref}`);
      }
    }
    lines.push("Switch model: /switch provider/model");
    await channel.send(peerId, { text: lines.join("\n") });
  }

  private async handleSwitchCommand(
    sessionKey: string,
    agentId: string,
    args: string,
    channel: ChannelPlugin,
    peerId: string,
  ): Promise<void> {
    const modelRef = args.trim();
    if (!modelRef) {
      const current = await this.agentManager.getAgent(sessionKey, agentId);
      await channel.send(peerId, {
        text: `Current model: ${current.modelRef}\nUsage: /switch provider/model`,
      });
      return;
    }
    const resolved = this.modelRegistry.resolve(modelRef);
    if (!resolved) {
      const suggestions = this.modelRegistry.suggestRefs(modelRef, 5);
      const suggestText =
        suggestions.length > 0
          ? `\nExample available models:\n${suggestions.map((ref) => `- ${ref}`).join("\n")}`
          : "";
      await channel.send(peerId, { text: `Model not found: ${modelRef}${suggestText}` });
      return;
    }
    await this.agentManager.setSessionModel(sessionKey, resolved.ref);
    if (resolved.ref !== modelRef) {
      await channel.send(peerId, {
        text: `Switched to model: ${resolved.ref} (auto-corrected from: ${modelRef})`,
      });
      return;
    }
    await channel.send(peerId, { text: `Switched to model: ${resolved.ref}` });
  }

  private async handleStatusCommand(params: {
    sessionKey: string;
    agentId: string;
    message: InboundMessage;
    channel: ChannelPlugin;
    peerId: string;
  }): Promise<void> {
    const { sessionKey, agentId, message, channel, peerId } = params;
    const current = await this.agentManager.getAgent(sessionKey, agentId);
    const usage = this.agentManager.getContextUsage(sessionKey);
    const runtimeStatus = this.runtimeControl?.getStatus?.();

    const lines: string[] = [];

    lines.push(`🤖 Mozi ${this.getVersion()}`);

    lines.push(`🧠 Model: ${current.modelRef}`);

    if (usage) {
      lines.push(
        `📚 Context: ${this.formatTokens(usage.usedTokens)}/${this.formatTokens(usage.totalTokens)} (${usage.percentage}%) · 📝 ${usage.messageCount} messages`,
      );
    }

    lines.push(`🧵 Session: ${sessionKey}`);

    const runtimeMode = runtimeStatus
      ? `${runtimeStatus.running ? "running" : "stopped"} · pid=${runtimeStatus.pid ?? "n/a"} · uptime=${this.formatUptime(runtimeStatus.uptime)}`
      : "direct";
    lines.push(`⚙️ Runtime: ${runtimeMode}`);

    lines.push(
      `👤 User: ${message.senderId} · ${message.channel}:${message.peerType ?? "dm"}:${message.peerId}`,
    );

    await channel.send(peerId, { text: lines.join("\n") });
  }

  private getVersion(): string {
    return "1.0.2";
  }

  private formatUptime(seconds: number): string {
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

  private async handleNewSessionCommand(
    sessionKey: string,
    agentId: string,
    channel: ChannelPlugin,
    peerId: string,
  ): Promise<void> {
    const memoryConfig = resolveMemoryBackendConfig({ cfg: this.config, agentId });
    if (memoryConfig.persistence.enabled && memoryConfig.persistence.onNewReset) {
      const { agent } = await this.agentManager.getAgent(sessionKey, agentId);
      const success = await this.flushMemory(
        sessionKey,
        agentId,
        agent.messages,
        memoryConfig.persistence,
      );
      this.agentManager.updateSessionMetadata(sessionKey, {
        memoryFlush: {
          lastAttemptedCycle: 0,
          lastTimestamp: Date.now(),
          lastStatus: success ? "success" : "failure",
          trigger: "new",
        },
      });
    }

    this.agentManager.resetSession(sessionKey, agentId);
    await channel.send(peerId, { text: "New session started (rotated to a new session segment)." });
  }

  private async handleRestartCommand(channel: ChannelPlugin, peerId: string): Promise<void> {
    if (!this.runtimeControl?.restart) {
      await channel.send(peerId, {
        text: "Current runtime mode does not support /restart. Please run 'mozi runtime restart' on the host.",
      });
      return;
    }
    await channel.send(peerId, { text: "Restarting runtime..." });
    await this.runtimeControl.restart();
  }

  private async handleCompactCommand(params: {
    sessionKey: string;
    agentId: string;
    channel: ChannelPlugin;
    peerId: string;
  }): Promise<void> {
    const { sessionKey, agentId, channel, peerId } = params;
    await channel.send(peerId, { text: "Compacting session..." });

    const result = await this.agentManager.compactSession(sessionKey, agentId);
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

  private async handleContextCommand(params: {
    sessionKey: string;
    channel: ChannelPlugin;
    peerId: string;
  }): Promise<void> {
    const { sessionKey, channel, peerId } = params;

    const breakdown = this.agentManager.getContextBreakdown(sessionKey);
    if (!breakdown) {
      await channel.send(peerId, { text: "No active session." });
      return;
    }

    const usage = this.agentManager.getContextUsage(sessionKey);
    const lines = [
      "Context details:",
      `  System prompt: ${this.formatTokens(breakdown.systemPromptTokens)}`,
      `  User messages: ${this.formatTokens(breakdown.userMessageTokens)}`,
      `  Assistant messages: ${this.formatTokens(breakdown.assistantMessageTokens)}`,
      `  Tool results: ${this.formatTokens(breakdown.toolResultTokens)}`,
      `  ---`,
      `  Total: ${this.formatTokens(breakdown.totalTokens)}`,
    ];

    if (usage) {
      lines.push(`  Usage: ${usage.usedTokens}/${usage.totalTokens} (${usage.percentage}%)`);
    }

    await channel.send(peerId, { text: lines.join("\n") });
  }

  private async handleWhoamiCommand(params: {
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

  private isAuthEnabled(): boolean {
    return this.config.runtime?.auth?.enabled === true;
  }

  private parseAuthScope(arg: string | undefined, agentId: string): SecretScope {
    const raw = (arg || "").trim();
    if (!raw) {
      const defaultScope = this.config.runtime?.auth?.defaultScope ?? "agent";
      if (defaultScope === "global") {
        return { type: "global" };
      }
      return { type: "agent", agentId };
    }
    if (raw === "global") {
      return { type: "global" };
    }
    if (raw === "agent") {
      return { type: "agent", agentId };
    }
    if (raw.startsWith("agent:")) {
      const explicitAgent = raw.slice("agent:".length).trim();
      return { type: "agent", agentId: explicitAgent || agentId };
    }
    return { type: "agent", agentId };
  }

  private formatScope(scope: SecretScope): string {
    if (scope.type === "global") {
      return "global";
    }
    return `agent:${scope.agentId}`;
  }

  private parseAuthArgs(args: string): {
    command: "set" | "unset" | "list" | "check";
    name?: string;
    value?: string;
    scopeArg?: string;
  } | null {
    const trimmed = args.trim();
    if (!trimmed) {
      return null;
    }
    const parts = trimmed.split(/\s+/);
    const sub = parts[0]?.toLowerCase();
    const scopeArg = parts.find((p) => p.startsWith("--scope="))?.slice("--scope=".length);
    if (sub === "set") {
      const keyValue = parts.find((p, i) => i > 0 && p.includes("="));
      if (!keyValue) {
        return { command: "set", scopeArg };
      }
      const idx = keyValue.indexOf("=");
      const name = keyValue.slice(0, idx).trim();
      const value = keyValue.slice(idx + 1);
      return { command: "set", name, value, scopeArg };
    }
    if (sub === "unset") {
      return { command: "unset", name: parts[1], scopeArg };
    }
    if (sub === "list") {
      return { command: "list", scopeArg };
    }
    if (sub === "check") {
      return { command: "check", name: parts[1], scopeArg };
    }
    return null;
  }

  private async handleAuthCommand(params: {
    args: string;
    agentId: string;
    senderId: string;
    channel: ChannelPlugin;
    peerId: string;
  }): Promise<void> {
    const { args, agentId, senderId, channel, peerId } = params;
    if (!this.isAuthEnabled()) {
      await channel.send(peerId, {
        text: "Auth broker is disabled. Set runtime.auth.enabled=true in config to use /setAuth commands.",
      });
      return;
    }
    try {
      const parsed = this.parseAuthArgs(args);
      if (!parsed) {
        await channel.send(peerId, {
          text: "Usage:\n/setAuth set KEY=VALUE [--scope=agent|global|agent:<id>]\n/unsetAuth KEY [--scope=agent|global|agent:<id>]\n/listAuth [--scope=agent|global|agent:<id>]\n/checkAuth KEY [--scope=agent|global|agent:<id>]",
        });
        return;
      }

      const scope = this.parseAuthScope(parsed.scopeArg, agentId);
      const masterKeyEnv = this.config.runtime?.auth?.masterKeyEnv ?? "MOZI_MASTER_KEY";
      this.secretBroker = createRuntimeSecretBroker({ masterKeyEnv });

      if (parsed.command === "set") {
        if (!parsed.name || !parsed.value) {
          await channel.send(peerId, { text: "Usage: /setAuth set KEY=VALUE [--scope=...]" });
          return;
        }
        await this.secretBroker.set({
          name: parsed.name,
          value: parsed.value,
          scope,
          actor: senderId,
        });
        await channel.send(peerId, {
          text: `Auth key '${parsed.name}' stored for scope ${this.formatScope(scope)}.`,
        });
        return;
      }

      if (parsed.command === "unset") {
        if (!parsed.name) {
          await channel.send(peerId, { text: "Usage: /unsetAuth KEY [--scope=...]" });
          return;
        }
        const removed = await this.secretBroker.unset({ name: parsed.name, scope });
        await channel.send(peerId, {
          text: removed
            ? `Auth key '${parsed.name}' removed from scope ${this.formatScope(scope)}.`
            : `Auth key '${parsed.name}' not found in scope ${this.formatScope(scope)}.`,
        });
        return;
      }

      if (parsed.command === "list") {
        const list = await this.secretBroker.list({ scope });
        if (list.length === 0) {
          await channel.send(peerId, {
            text: `No auth keys stored in scope ${this.formatScope(scope)}.`,
          });
          return;
        }
        const lines = ["Auth keys:"];
        for (const item of list) {
          lines.push(
            `- ${item.name} (${this.formatScope(item.scope)}) updated=${item.updatedAt}${item.lastUsedAt ? ` lastUsed=${item.lastUsedAt}` : ""}`,
          );
        }
        await channel.send(peerId, { text: lines.join("\n") });
        return;
      }

      if (!parsed.name) {
        await channel.send(peerId, { text: "Usage: /checkAuth KEY [--scope=...]" });
        return;
      }
      const check = await this.secretBroker.check({ name: parsed.name, agentId, scope });
      await channel.send(peerId, {
        text: check.exists
          ? `Auth key '${parsed.name}' exists (${this.formatScope(check.scope || scope)}).`
          : `Auth key '${parsed.name}' is missing. Set it with /setAuth set ${parsed.name}=<value> [--scope=...]`,
      });
    } catch (error) {
      await channel.send(peerId, {
        text: `Auth command failed: ${this.toError(error).message}`,
      });
    }
  }

  private parseMissingAuthKey(message: string): string | null {
    const marker = /AUTH_MISSING[:\s]+([A-Z0-9_]+)/i.exec(message);
    if (marker?.[1]) {
      return marker[1];
    }
    const simple = /missing auth(?:entication)?(?: secret| key)?[:\s]+([A-Z0-9_]+)/i.exec(message);
    if (simple?.[1]) {
      return simple[1];
    }
    return null;
  }

  private isMissingAuthError(message: string): boolean {
    const lower = message.toLowerCase();
    return (
      lower.includes("auth_missing") ||
      lower.includes("missing auth") ||
      lower.includes("missing authentication")
    );
  }

  private formatTokens(tokens: number): string {
    if (tokens < 1000) {
      return `${tokens} tokens`;
    }
    if (tokens < 1_000_000) {
      return `${(tokens / 1000).toFixed(1)}K tokens`;
    }
    return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
  }

  private parseCommand(text: string): {
    name:
      | "start"
      | "help"
      | "status"
      | "whoami"
      | "new"
      | "models"
      | "switch"
      | "restart"
      | "compact"
      | "context"
      | "setauth"
      | "unsetauth"
      | "listauth"
      | "checkauth"
      | "reminders";
    args: string;
  } | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) {
      return null;
    }
    const token = trimmed.split(/\s+/, 1)[0] || "";
    const normalized = token.split("@", 1)[0].toLowerCase();
    const args = trimmed.slice(token.length).trim();
    if (
      normalized !== "/start" &&
      normalized !== "/help" &&
      normalized !== "/status" &&
      normalized !== "/whoami" &&
      normalized !== "/id" &&
      normalized !== "/new" &&
      normalized !== "/models" &&
      normalized !== "/switch" &&
      normalized !== "/model" &&
      normalized !== "/restart" &&
      normalized !== "/compact" &&
      normalized !== "/context" &&
      normalized !== "/setauth" &&
      normalized !== "/unsetauth" &&
      normalized !== "/listauth" &&
      normalized !== "/checkauth" &&
      normalized !== "/reminders"
    ) {
      return null;
    }
    let commandName = normalized.slice(1);
    if (commandName === "model") {
      commandName = "switch";
    }
    if (commandName === "id") {
      commandName = "whoami";
    }
    return {
      name: commandName as
        | "start"
        | "help"
        | "status"
        | "whoami"
        | "new"
        | "models"
        | "switch"
        | "restart"
        | "compact"
        | "context"
        | "setauth"
        | "unsetauth"
        | "listauth"
        | "checkauth"
        | "reminders",
      args,
    };
  }

  private parseDurationMs(input: string): number | null {
    const trimmed = input.trim().toLowerCase();
    if (!trimmed) {
      return null;
    }
    if (/^\d+$/.test(trimmed)) {
      return Number(trimmed);
    }
    const matched = trimmed.match(/^(\d+)(ms|s|m|h|d)$/);
    if (!matched) {
      return null;
    }
    const amount = Number(matched[1]);
    const unit = matched[2];
    if (unit === "ms") {
      return amount;
    }
    if (unit === "s") {
      return amount * 1000;
    }
    if (unit === "m") {
      return amount * 60_000;
    }
    if (unit === "h") {
      return amount * 3_600_000;
    }
    return amount * 86_400_000;
  }

  private parseAtMs(input: string): number | null {
    const trimmed = input.trim();
    if (!trimmed) {
      return null;
    }
    if (/^\d+$/.test(trimmed)) {
      return Number(trimmed);
    }
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) {
      return null;
    }
    return parsed;
  }

  private async handleRemindersCommand(params: {
    sessionKey: string;
    message: InboundMessage;
    channel: ChannelPlugin;
    peerId: string;
    args: string;
  }): Promise<void> {
    const { sessionKey, message, channel, peerId, args } = params;
    const raw = args.trim();

    if (!raw || /^list(?:\s+all)?(?:\s+\d+)?$/i.test(raw)) {
      const listMatched = raw.match(/^list(?:\s+(all))?(?:\s+(\d+))?$/i);
      const includeDisabled = Boolean(listMatched?.[1]);
      const limit = listMatched?.[2] ? Math.max(1, Number(listMatched[2])) : 20;
      const rows = reminders.listBySession(sessionKey, { includeDisabled, limit });
      if (rows.length === 0) {
        await channel.send(peerId, { text: "No reminders." });
        return;
      }
      const lines = ["Reminders:"];
      for (const row of rows) {
        const status = row.enabled === 1 ? "enabled" : "disabled";
        lines.push(
          `- ${row.id} [${status}] next=${row.next_run_at ?? "none"} msg=${row.message.slice(0, 80)}`,
        );
      }
      await channel.send(peerId, { text: lines.join("\n") });
      return;
    }

    const createMatched = raw.match(/^(?:create|add)\s+(in|every|at)\s+(\S+)\s+([\s\S]+)$/i);
    if (createMatched) {
      const mode = createMatched[1].toLowerCase();
      const timeArg = createMatched[2];
      const reminderText = createMatched[3].trim();
      if (!reminderText) {
        await channel.send(peerId, { text: "Reminder message cannot be empty." });
        return;
      }
      const now = Date.now();
      let schedule: Schedule;
      if (mode === "in") {
        const durationMs = this.parseDurationMs(timeArg);
        if (!durationMs || durationMs <= 0) {
          await channel.send(peerId, { text: "Invalid duration. Example: 10m, 30s, 5000" });
          return;
        }
        schedule = { kind: "at", atMs: now + durationMs };
      } else if (mode === "every") {
        const durationMs = this.parseDurationMs(timeArg);
        if (!durationMs || durationMs <= 0) {
          await channel.send(peerId, { text: "Invalid interval. Example: 10m, 1h, 60000" });
          return;
        }
        schedule = { kind: "every", everyMs: durationMs, anchorMs: now };
      } else {
        const atMs = this.parseAtMs(timeArg);
        if (!atMs) {
          await channel.send(peerId, {
            text: "Invalid at time. Use unix ms or ISO datetime (quoted).",
          });
          return;
        }
        schedule = { kind: "at", atMs };
      }
      const nextRun = computeNextRun(schedule, now);
      if (!nextRun) {
        await channel.send(peerId, { text: "Schedule has no future run." });
        return;
      }
      const reminderId = randomUUID();
      reminders.create({
        id: reminderId,
        sessionKey,
        channelId: message.channel,
        peerId: message.peerId,
        peerType: message.peerType ?? "dm",
        message: reminderText,
        scheduleKind: schedule.kind,
        scheduleJson: JSON.stringify(schedule),
        nextRunAt: nextRun.toISOString(),
      });
      await channel.send(peerId, {
        text: `Reminder created: ${reminderId}\nnextRunAt: ${nextRun.toISOString()}`,
      });
      return;
    }

    const updateMatched = raw.match(/^(?:update)\s+(\S+)\s+(in|every|at)\s+(\S+)\s+([\s\S]+)$/i);
    if (updateMatched) {
      const reminderId = updateMatched[1];
      const mode = updateMatched[2].toLowerCase();
      const timeArg = updateMatched[3];
      const reminderText = updateMatched[4].trim();
      if (!reminderText) {
        await channel.send(peerId, { text: "Reminder message cannot be empty." });
        return;
      }
      const now = Date.now();
      let schedule: Schedule;
      if (mode === "in") {
        const durationMs = this.parseDurationMs(timeArg);
        if (!durationMs || durationMs <= 0) {
          await channel.send(peerId, { text: "Invalid duration. Example: 10m, 30s, 5000" });
          return;
        }
        schedule = { kind: "at", atMs: now + durationMs };
      } else if (mode === "every") {
        const durationMs = this.parseDurationMs(timeArg);
        if (!durationMs || durationMs <= 0) {
          await channel.send(peerId, { text: "Invalid interval. Example: 10m, 1h, 60000" });
          return;
        }
        schedule = { kind: "every", everyMs: durationMs, anchorMs: now };
      } else {
        const atMs = this.parseAtMs(timeArg);
        if (!atMs) {
          await channel.send(peerId, {
            text: "Invalid at time. Use unix ms or ISO datetime (quoted).",
          });
          return;
        }
        schedule = { kind: "at", atMs };
      }
      const nextRun = computeNextRun(schedule, now);
      const updated = reminders.updateBySession({
        id: reminderId,
        sessionKey,
        message: reminderText,
        scheduleKind: schedule.kind,
        scheduleJson: JSON.stringify(schedule),
        nextRunAt: nextRun ? nextRun.toISOString() : null,
      });
      await channel.send(peerId, {
        text: updated
          ? `Reminder updated: ${reminderId}\nnextRunAt: ${nextRun ? nextRun.toISOString() : "none"}`
          : `Reminder not found: ${reminderId}`,
      });
      return;
    }

    const cancelMatched = raw.match(/^cancel\s+(\S+)$/i);
    if (cancelMatched) {
      const reminderId = cancelMatched[1];
      const cancelled = reminders.cancelBySession(reminderId, sessionKey);
      await channel.send(peerId, {
        text: cancelled ? `Reminder cancelled: ${reminderId}` : `Reminder not found: ${reminderId}`,
      });
      return;
    }

    const snoozeMatched = raw.match(/^snooze\s+(\S+)\s+(\S+)$/i);
    if (snoozeMatched) {
      const reminderId = snoozeMatched[1];
      const durationMs = this.parseDurationMs(snoozeMatched[2]);
      if (!durationMs || durationMs <= 0) {
        await channel.send(peerId, { text: "Invalid snooze duration. Example: 10m, 30s, 5000" });
        return;
      }
      const nextRunAt = new Date(Date.now() + durationMs).toISOString();
      const snoozed = reminders.updateNextRunBySession({
        id: reminderId,
        sessionKey,
        nextRunAt,
      });
      await channel.send(peerId, {
        text: snoozed
          ? `Reminder snoozed: ${reminderId}\nnextRunAt: ${nextRunAt}`
          : `Reminder not found: ${reminderId}`,
      });
      return;
    }

    await channel.send(peerId, {
      text: "Usage:\n/reminders list [all] [limit]\n/reminders create in <duration> <message>\n/reminders create every <duration> <message>\n/reminders create at <unixMs|ISO> <message>\n/reminders update <id> in|every|at <time> <message>\n/reminders snooze <id> <duration>\n/reminders cancel <id>",
    });
  }

  private async runPromptWithFallback(params: {
    sessionKey: string;
    agentId: string;
    text: string;
    onStream?: StreamingCallback;
  }): Promise<void> {
    const { sessionKey, agentId, text, onStream } = params;
    const fallbacks = this.agentManager.getAgentFallbacks(agentId);
    const tried = new Set<string>();
    let attempt = 0;
    let overflowCompactionAttempts = 0;

    while (true) {
      const { agent, modelRef } = await this.agentManager.getAgent(sessionKey, agentId);
      attempt += 1;
      const startedAt = Date.now();
      const progressTimer = setInterval(() => {
        logger.warn(
          {
            sessionKey,
            agentId,
            modelRef,
            attempt,
            elapsedMs: Date.now() - startedAt,
            textChars: text.length,
          },
          "Agent prompt still running",
        );
      }, MessageHandler.PROMPT_PROGRESS_LOG_INTERVAL_MS);

      let unsubscribe: (() => void) | undefined;
      let accumulatedText = "";

      try {
        this.registerActivePromptRun({
          sessionKey,
          agentId,
          modelRef,
          startedAt,
          agent,
        });
        logger.info(
          { sessionKey, agentId, modelRef, attempt, textChars: text.length },
          "Agent prompt started",
        );

        if (onStream && typeof agent.subscribe === "function") {
          unsubscribe = agent.subscribe((event: AgentSessionEvent) => {
            void this.handleAgentStreamEvent(event, onStream, (text) => {
              accumulatedText = text;
            });
          });
        }

        await Promise.race([
          agent.prompt(text),
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error("Agent prompt timeout")),
              MessageHandler.PROMPT_EXECUTION_TIMEOUT_MS,
            );
          }),
        ]);

        if (onStream && accumulatedText) {
          await onStream({ type: "agent_end", fullText: accumulatedText });
        }

        const latestAssistant = [...(agent.messages as Array<{ role?: string }>)]
          .toReversed()
          .find((m) => m && m.role === "assistant");
        const failureReason = getAssistantFailureReason(latestAssistant);
        if (failureReason) {
          throw new Error(failureReason);
        }
        this.agentManager.updateSessionContext(sessionKey, agent.messages);
        const usage = this.agentManager.getContextUsage(sessionKey);
        if (usage) {
          logger.debug(
            {
              sessionKey,
              agentId,
              responseTokens: latestAssistant
                ? estimateMessagesTokens([latestAssistant as AgentMessage])
                : 0,
              totalContextTokens: usage.usedTokens,
              contextWindow: usage.totalTokens,
              fillPercentage: usage.percentage,
            },
            "Prompt completed with usage stats",
          );
        }
        logger.info(
          { sessionKey, agentId, modelRef, attempt, elapsedMs: Date.now() - startedAt },
          "Agent prompt completed",
        );
        return;
      } catch (error) {
        const err = this.toError(error);
        if (this.interruptedPromptRuns.has(sessionKey)) {
          const abortError = new Error("Interrupted by queue mode", { cause: err });
          abortError.name = "AbortError";
          throw abortError;
        }
        if (this.isAbortError(err)) {
          throw err;
        }
        if (this.isAgentBusyError(err)) {
          logger.warn(
            { sessionKey, agentId, modelRef, attempt, error: err.message },
            "Agent busy; waiting for idle and retrying current model",
          );
          await this.waitForAgentIdle(agent);
          continue;
        }
        if (this.isCapabilityError(err)) {
          throw err;
        }

        const errorText = err.message || String(err);
        if (isContextOverflowError(errorText) && !isCompactionFailureError(errorText)) {
          if (overflowCompactionAttempts < MessageHandler.MAX_OVERFLOW_COMPACTION_ATTEMPTS) {
            overflowCompactionAttempts++;
            logger.warn(
              { sessionKey, agentId, attempt: overflowCompactionAttempts },
              "Context overflow detected, triggering auto-compaction",
            );

            const memoryConfig = resolveMemoryBackendConfig({ cfg: this.config, agentId });
            if (memoryConfig.persistence.enabled && memoryConfig.persistence.onOverflowCompaction) {
              const meta = this.agentManager.getSessionMetadata(sessionKey)?.memoryFlush as
                | FlushMetadata
                | undefined;
              if (!meta || meta.lastAttemptedCycle < overflowCompactionAttempts) {
                const success = await this.flushMemory(
                  sessionKey,
                  agentId,
                  agent.messages,
                  memoryConfig.persistence,
                );
                this.agentManager.updateSessionMetadata(sessionKey, {
                  memoryFlush: {
                    lastAttemptedCycle: overflowCompactionAttempts,
                    lastTimestamp: Date.now(),
                    lastStatus: success ? "success" : "failure",
                    trigger: "overflow",
                  },
                });
              }
            }

            const compactResult = await this.agentManager.compactSession(sessionKey, agentId);
            if (compactResult.success) {
              logger.info(
                { sessionKey, tokensReclaimed: compactResult.tokensReclaimed },
                "Auto-compaction succeeded, retrying prompt",
              );
              continue;
            }
            logger.warn({ sessionKey, reason: compactResult.reason }, "Auto-compaction failed");
          }
          logger.error(
            { sessionKey, agentId },
            "Context overflow: prompt too large. Try /compact or /new.",
          );
          throw err;
        }

        tried.add(modelRef);
        const nextFallback = fallbacks.find((m) => !tried.has(m));
        if (!nextFallback) {
          throw err;
        }
        logger.warn(
          {
            sessionKey,
            agentId,
            fromModel: modelRef,
            toModel: nextFallback,
            attempt,
            error: err.message,
          },
          "Agent prompt failed, switching to fallback model",
        );
        await this.agentManager.setSessionModel(sessionKey, nextFallback);
      } finally {
        if (unsubscribe) {
          unsubscribe();
        }
        this.clearActivePromptRun(sessionKey);
        clearInterval(progressTimer);
      }
    }
  }

  private async handleAgentStreamEvent(
    event: AgentSessionEvent,
    onStream: StreamingCallback,
    updateAccumulated: (text: string) => void,
  ): Promise<void> {
    if (event.type === "message_update") {
      const assistantEvent = event.assistantMessageEvent;
      if (assistantEvent.type === "text_delta") {
        updateAccumulated(assistantEvent.delta);
        await onStream({ type: "text_delta", delta: assistantEvent.delta });
      }
    } else if (event.type === "tool_execution_start") {
      await onStream({
        type: "tool_start",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
      });
    } else if (event.type === "tool_execution_end") {
      await onStream({
        type: "tool_end",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        isError: event.isError,
      });
    }
  }

  isSessionActive(sessionKey: string): boolean {
    return this.activePromptRuns.has(sessionKey);
  }

  async steerSession(
    sessionKey: string,
    text: string,
    mode: "steer" | "followup" = "steer",
  ): Promise<boolean> {
    const active = this.activePromptRuns.get(sessionKey);
    if (!active) {
      return false;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }

    if (mode === "followup" && typeof active.agent.followUp === "function") {
      await Promise.resolve(active.agent.followUp(trimmed));
      logger.info(
        { sessionKey, agentId: active.agentId, modelRef: active.modelRef, mode },
        "Injected follow-up message into active agent run",
      );
      return true;
    }

    if (typeof active.agent.steer === "function") {
      await Promise.resolve(active.agent.steer(trimmed));
      logger.info(
        { sessionKey, agentId: active.agentId, modelRef: active.modelRef, mode },
        "Injected steering message into active agent run",
      );
      return true;
    }

    if (mode === "steer" && typeof active.agent.followUp === "function") {
      await Promise.resolve(active.agent.followUp(trimmed));
      logger.info(
        { sessionKey, agentId: active.agentId, modelRef: active.modelRef, mode: "followup" },
        "Injected follow-up message into active agent run as steer fallback",
      );
      return true;
    }

    return false;
  }

  async interruptSession(
    sessionKey: string,
    reason = "Interrupted by queue mode",
  ): Promise<boolean> {
    const active = this.activePromptRuns.get(sessionKey);
    if (!active) {
      return false;
    }
    this.interruptedPromptRuns.add(sessionKey);
    logger.warn(
      {
        sessionKey,
        agentId: active.agentId,
        modelRef: active.modelRef,
        elapsedMs: Date.now() - active.startedAt,
        reason,
      },
      "Interrupting active agent run",
    );
    try {
      if (typeof active.agent.abort === "function") {
        await Promise.resolve(active.agent.abort());
      }
      await this.waitForAgentIdle(active.agent, MessageHandler.INTERRUPT_WAIT_TIMEOUT_MS);
      return true;
    } catch (error) {
      logger.warn(
        {
          sessionKey,
          agentId: active.agentId,
          error: this.toError(error).message,
        },
        "Interrupt wait ended with error",
      );
      return true;
    }
  }

  private registerActivePromptRun(params: {
    sessionKey: string;
    agentId: string;
    modelRef: string;
    startedAt: number;
    agent: ActivePromptAgent;
  }): void {
    this.interruptedPromptRuns.delete(params.sessionKey);
    this.activePromptRuns.set(params.sessionKey, {
      agentId: params.agentId,
      modelRef: params.modelRef,
      startedAt: params.startedAt,
      agent: params.agent,
    });
  }

  private clearActivePromptRun(sessionKey: string): void {
    this.activePromptRuns.delete(sessionKey);
    this.interruptedPromptRuns.delete(sessionKey);
  }

  private async waitForAgentIdle(_agent: ActivePromptAgent, timeoutMs?: number): Promise<void> {
    const SETTLE_DELAY_MS = 50;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(timeoutMs ?? SETTLE_DELAY_MS, SETTLE_DELAY_MS)),
    );
  }

  private async flushMemory(
    sessionKey: string,
    agentId: string,
    messages: AgentMessage[],
    config: ResolvedMemoryPersistenceConfig,
  ): Promise<boolean> {
    const flushManager = new FlushManager(resolveHomeDir(this.config, agentId));
    try {
      const timeout = config.timeoutMs || 1500;
      const result = await Promise.race([
        flushManager.flush({ messages, config, sessionKey }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Flush timeout")), timeout)),
      ]);
      const success = result === true;
      if (success) {
        const lifecycle = await getMemoryLifecycleOrchestrator(this.config, agentId);
        await lifecycle.handle({ type: "flush_completed", sessionKey });
      }
      return success;
    } catch (err) {
      logger.warn({ err, sessionKey }, "Memory flush failed or timed out");
      return false;
    }
  }

  private toError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }
    return new Error(String(error));
  }

  private isAgentBusyError(error: Error): boolean {
    return error.message.toLowerCase().includes("already processing a prompt");
  }

  private isAbortError(error: Error): boolean {
    if (error.name === "AbortError") {
      return true;
    }
    return error.message === "This operation was aborted";
  }

  private isCapabilityError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes("image_url") ||
      message.includes("unsupported input") ||
      message.includes("does not support image") ||
      message.includes("does not support audio") ||
      message.includes("does not support video") ||
      message.includes("does not support file")
    );
  }

  private mediaTypeToInput(
    type: "photo" | "video" | "audio" | "document" | "voice",
  ): "image" | "audio" | "video" | "file" {
    if (type === "photo") {
      return "image";
    }
    if (type === "video") {
      return "video";
    }
    if (type === "audio" || type === "voice") {
      return "audio";
    }
    return "file";
  }

  private describeInput(input: "image" | "audio" | "video" | "file"): string {
    switch (input) {
      case "image":
        return "image";
      case "audio":
        return "audio";
      case "video":
        return "video";
      case "file":
        return "file";
    }
  }

  private modelConfigHint(
    agentId: string,
    input: "image" | "audio" | "video" | "file",
  ): string {
    if (input === "image") {
      return `agents.${agentId}.imageModel (or agents.defaults.imageModel)`;
    }
    return "media understanding pipeline (transcription/description)";
  }

  private buildPromptText(params: {
    message: InboundMessage;
    rawText: string;
    ingestPlan?: DeliveryPlan | null;
  }): string {
    const lines: string[] = [];
    const providerPayload = buildProviderInputPayload(params.ingestPlan);
    const trimmed = params.rawText.trim();
    if (trimmed) {
      lines.push(trimmed);
    }

    if (providerPayload.text && !lines.includes(providerPayload.text)) {
      lines.push(providerPayload.text);
    }

    if (providerPayload.media.length > 0) {
      const mediaSummary = providerPayload.media
        .map((item, index) => {
          const mime = item.mimeType ? `, mime=${item.mimeType}` : "";
          const filename = item.filename ? `, filename=${item.filename}` : "";
          return `- [media#${index + 1}] modality=${item.modality}, id=${item.mediaId}${mime}${filename}`;
        })
        .join("\n");
      lines.push(`Attached media:\n${mediaSummary}`);
    }

    if (providerPayload.metadata.fallbackUsed && providerPayload.metadata.transforms.length > 0) {
      const transformSummary = providerPayload.metadata.transforms
        .map((item) => `- ${item.from} -> ${item.to} (${item.reason})`)
        .join("\n");
      lines.push(`Input degradation strategy:\n${transformSummary}`);
    }

    return lines.join("\n\n").trim();
  }

  private buildRawTextWithTranscription(rawText: string, transcript: string | null): string {
    if (!transcript) {
      return rawText;
    }

    const base = rawText.trim();
    if (!base) {
      return transcript;
    }
    return `${base}\n\n[voice transcript]\n${transcript}`;
  }

  private async checkInputCapability(params: {
    sessionKey: string;
    agentId: string;
    message: InboundMessage;
    channel: ChannelPlugin;
    peerId: string;
    hasAudioTranscript: boolean;
  }): Promise<{ ok: boolean; restoreModelRef?: string }> {
    const media = params.message.media || [];
    if (media.length === 0) {
      return { ok: true };
    }
    const currentBeforeRouting = await this.agentManager.getAgent(params.sessionKey, params.agentId);
    const restoreModelRef = currentBeforeRouting.modelRef;
    let switched = false;
    const requiredInputs = Array.from(
      new Set(media.map((item) => this.mediaTypeToInput(item.type))),
    );
    for (const input of requiredInputs) {
      if (input === "audio" && params.hasAudioTranscript) {
        logger.info(
          {
            sessionKey: params.sessionKey,
            agentId: params.agentId,
            mediaCount: media.length,
            input,
          },
          "Skipping audio capability degradation because transcript is available",
        );
        continue;
      }

      const routed = await this.agentManager.ensureSessionModelForInput({
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        input,
      });
      if (routed.ok) {
        if (routed.switched) {
          switched = true;
          logger.info(
            {
              sessionKey: params.sessionKey,
              agentId: params.agentId,
              modelRef: routed.modelRef,
              mediaCount: media.length,
              input,
            },
            "Input capability auto-switched model",
          );
        }
        continue;
      }

      const suggestText =
        routed.candidates.length > 0
          ? `\nAvailable ${this.describeInput(input)} models:\n${routed.candidates.map((ref) => `- ${ref}`).join("\n")}`
          : "";
      await params.channel.send(params.peerId, {
        text: `Current model ${routed.modelRef} does not support ${this.describeInput(input)} input. Continuing with text degradation. Configure ${this.modelConfigHint(params.agentId, input)} or manually /switch to a model that supports ${input}. ${suggestText}`,
      });
      logger.warn(
        {
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          modelRef: routed.modelRef,
          mediaCount: media.length,
          candidates: routed.candidates,
          input,
        },
        "Input capability degraded to text",
      );
    }
    return { ok: true, restoreModelRef: switched ? restoreModelRef : undefined };
  }

  private async startTypingIndicator(params: {
    channel: ChannelPlugin;
    peerId: string;
    sessionKey: string;
    agentId: string;
  }): Promise<(() => Promise<void> | void) | undefined> {
    if (typeof params.channel.beginTyping !== "function") {
      return undefined;
    }
    try {
      const stop = await params.channel.beginTyping(params.peerId);
      return stop ?? undefined;
    } catch (error) {
      logger.warn(
        {
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          peerId: params.peerId,
          error: this.toError(error).message,
        },
        "Failed to start typing indicator",
      );
      return undefined;
    }
  }

  private async stopTypingIndicator(params: {
    stop?: () => Promise<void> | void;
    sessionKey: string;
    agentId: string;
    peerId: string;
  }): Promise<void> {
    if (!params.stop) {
      return;
    }
    try {
      await params.stop();
    } catch (error) {
      logger.warn(
        {
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          peerId: params.peerId,
          error: this.toError(error).message,
        },
        "Failed to stop typing indicator",
      );
    }
  }

  private async emitPhaseSafely(params: {
    channel: ChannelPlugin;
    peerId: string;
    phase: "idle" | "listening" | "thinking" | "speaking" | "executing" | "error";
    payload?: {
      sessionKey?: string;
      agentId?: string;
      toolName?: string;
      toolCallId?: string;
      messageId?: string;
    };
  }): Promise<void> {
    if (typeof params.channel.emitPhase !== "function") {
      return;
    }
    try {
      await params.channel.emitPhase(params.peerId, params.phase, params.payload);
    } catch (error) {
      logger.warn(
        {
          peerId: params.peerId,
          phase: params.phase,
          error: this.toError(error).message,
        },
        "Failed to emit channel phase",
      );
    }
  }

  getLastRoute(agentId: string): LastRoute | undefined {
    return this.lastRoutes.get(agentId);
  }

  resolveSessionContext(message: InboundMessage): ResolvedSessionContext {
    const defaultAgentId = this.agentManager.resolveDefaultAgentId();
    const route = this.router.resolve(message, defaultAgentId);
    const agentId = route.agentId;
    const sessionKey = buildSessionKey({
      agentId,
      message,
      dmScope: route.dmScope,
    });
    return {
      agentId,
      sessionKey,
      dmScope: route.dmScope,
      peerId: message.peerId,
    };
  }

  async handle(message: InboundMessage, channel: ChannelPlugin): Promise<void> {
    const startedAt = Date.now();
    const text = this.getText(message);
    const media = message.media || [];
    if (text.trim().length === 0 && media.length === 0) {
      return;
    }
    const parsedCommand = this.parseCommand(text);
    if (text.startsWith("/") && !parsedCommand) {
      logger.debug(
        { channel: message.channel, peerId: message.peerId, text },
        "Ignoring unsupported command",
      );
      return;
    }

    const context = this.resolveSessionContext(message);
    const agentId = context.agentId;
    this.lastRoutes.set(agentId, {
      channelId: message.channel,
      peerId: message.peerId,
      peerType: message.peerType ?? "dm",
      accountId: message.accountId,
      threadId: message.threadId,
    });
    const sessionKey = context.sessionKey;
    const peerId = message.peerId;

    if (
      message.raw &&
      typeof message.raw === "object" &&
      (message.raw as { source?: string }).source === "reminder"
    ) {
      await channel.send(peerId, {
        text: text.trim() || "Reminder",
      });
      logger.info(
        {
          sessionKey,
          agentId,
          messageId: message.id,
          durationMs: Date.now() - startedAt,
          source: "reminder",
        },
        "Reminder delivered",
      );
      return;
    }

    logger.info(
      {
        messageId: message.id,
        channel: message.channel,
        peerId: message.peerId,
        senderId: message.senderId,
        peerType: message.peerType ?? "dm",
        agentId,
        sessionKey,
        dmScope: context.dmScope,
        isCommand: Boolean(parsedCommand),
      },
      "Message handling started",
    );
    if (parsedCommand) {
      logger.info(
        { sessionKey, agentId, command: parsedCommand.name, args: parsedCommand.args },
        "Command parsed",
      );
    }

    try {
      if (parsedCommand?.name === "help") {
        await channel.send(peerId, {
          text: "Available commands:\n/status View status\n/whoami View identity information\n/new Start new session\n/models List available models\n/switch provider/model Switch model\n/compact Compact session context\n/context View context details\n/restart Restart runtime\n/reminders Reminder management\n/setAuth set KEY=VALUE [--scope=...]\n/unsetAuth KEY [--scope=...]\n/listAuth [--scope=...]\n/checkAuth KEY [--scope=...]",
        });
        logger.info(
          { sessionKey, agentId, command: "help", durationMs: Date.now() - startedAt },
          "Command handled",
        );
        return;
      }

      if (parsedCommand?.name === "whoami") {
        await this.handleWhoamiCommand({ message, channel, peerId });
        logger.info(
          { sessionKey, agentId, command: "whoami", durationMs: Date.now() - startedAt },
          "Command handled",
        );
        return;
      }

      if (parsedCommand?.name === "status") {
        await this.handleStatusCommand({
          sessionKey,
          agentId,
          message,
          channel,
          peerId,
        });
        logger.info(
          { sessionKey, agentId, command: "status", durationMs: Date.now() - startedAt },
          "Command handled",
        );
        return;
      }

      if (parsedCommand?.name === "new") {
        await this.handleNewSessionCommand(sessionKey, agentId, channel, peerId);
        logger.info(
          { sessionKey, agentId, command: "new", durationMs: Date.now() - startedAt },
          "Command handled",
        );
        return;
      }

      if (parsedCommand?.name === "models") {
        await this.handleModelsCommand(sessionKey, agentId, channel, peerId);
        logger.info(
          { sessionKey, agentId, command: "models", durationMs: Date.now() - startedAt },
          "Command handled",
        );
        return;
      }

      if (parsedCommand?.name === "switch") {
        await this.handleSwitchCommand(sessionKey, agentId, parsedCommand.args, channel, peerId);
        logger.info(
          { sessionKey, agentId, command: "switch", durationMs: Date.now() - startedAt },
          "Command handled",
        );
        return;
      }

      if (parsedCommand?.name === "restart") {
        await this.handleRestartCommand(channel, peerId);
        logger.info(
          { sessionKey, agentId, command: "restart", durationMs: Date.now() - startedAt },
          "Command handled",
        );
        return;
      }

      if (parsedCommand?.name === "compact") {
        await this.handleCompactCommand({ sessionKey, agentId, channel, peerId });
        logger.info(
          { sessionKey, agentId, command: "compact", durationMs: Date.now() - startedAt },
          "Command handled",
        );
        return;
      }

      if (parsedCommand?.name === "context") {
        await this.handleContextCommand({ sessionKey, channel, peerId });
        logger.info(
          { sessionKey, agentId, command: "context", durationMs: Date.now() - startedAt },
          "Command handled",
        );
        return;
      }

      if (
        parsedCommand?.name === "setauth" ||
        parsedCommand?.name === "unsetauth" ||
        parsedCommand?.name === "listauth" ||
        parsedCommand?.name === "checkauth"
      ) {
        const subcommand =
          parsedCommand.name === "setauth"
            ? "set"
            : parsedCommand.name === "unsetauth"
              ? "unset"
              : parsedCommand.name === "listauth"
                ? "list"
                : "check";
        const mergedArgs = `${subcommand} ${parsedCommand.args}`.trim();
        await this.handleAuthCommand({
          args: mergedArgs,
          agentId,
          senderId: message.senderId,
          channel,
          peerId,
        });
        logger.info(
          { sessionKey, agentId, command: parsedCommand.name, durationMs: Date.now() - startedAt },
          "Command handled",
        );
        return;
      }

      if (parsedCommand?.name === "reminders") {
        await this.handleRemindersCommand({
          sessionKey,
          message,
          channel,
          peerId,
          args: parsedCommand.args,
        });
        logger.info(
          { sessionKey, agentId, command: "reminders", durationMs: Date.now() - startedAt },
          "Command handled",
        );
        return;
      }

      if (!parsedCommand && this.shouldRotateSessionForTemporalPolicy({ sessionKey, agentId })) {
        this.agentManager.resetSession(sessionKey, agentId);
        logger.info(
          { sessionKey, agentId, trigger: "temporal_freshness" },
          "Session auto-rotated by temporal lifecycle policy",
        );
      }

      if (!parsedCommand) {
        const semantic = this.evaluateSemanticLifecycle({
          sessionKey,
          agentId,
          text,
        });
        if (semantic.shouldRevert) {
          const reverted = this.sessions.revertToPreviousSegment(sessionKey, agentId);
          if (reverted) {
            this.agentManager.disposeRuntimeSession(sessionKey);
            this.agentManager.updateSessionMetadata(sessionKey, {
              lifecycle: {
                semantic: {
                  lastRotationAt: Date.now(),
                  lastRotationType: "semantic_revert",
                  lastConfidence: semantic.confidence,
                },
              },
            });
            logger.info(
              {
                sessionKey,
                agentId,
                trigger: "semantic_revert",
                confidence: semantic.confidence,
                threshold: semantic.threshold,
              },
              "Session semantic misfire reverted",
            );
          }
        } else if (semantic.shouldRotate) {
          this.agentManager.resetSession(sessionKey, agentId);
          this.agentManager.updateSessionMetadata(sessionKey, {
            lifecycle: {
              semantic: {
                lastRotationAt: Date.now(),
                lastRotationType: "semantic",
                lastConfidence: semantic.confidence,
                controlModelRef: semantic.controlModelRef,
              },
            },
          });
          logger.info(
            {
              sessionKey,
              agentId,
              trigger: "semantic_shift",
              confidence: semantic.confidence,
              threshold: semantic.threshold,
              controlModelRef: semantic.controlModelRef,
            },
            "Session auto-rotated by semantic lifecycle policy",
          );
        }
      }

      const transcript = await this.sttService.transcribeInboundMessage(message);
      const hasAudioTranscript = typeof transcript === "string" && transcript.trim().length > 0;

      const capability = await this.checkInputCapability({
        sessionKey,
        agentId,
        message,
        channel,
        peerId,
        hasAudioTranscript,
      });
      if (!capability.ok) {
        return;
      }

      const currentAgent = await this.agentManager.getAgent(sessionKey, agentId);
      const modelSpec = this.modelRegistry.get(currentAgent.modelRef);

      const ingestPlan = ingestInboundMessage({
        message,
        sessionKey,
        channelId: channel.id,
        modelRef: currentAgent.modelRef,
        modelSpec,
      });

      this.agentManager.updateSessionMetadata(sessionKey, {
        multimodal: {
          inboundPlan: ingestPlan,
        },
      });

      const textWithTranscription = this.buildRawTextWithTranscription(text, transcript);
      const promptText = this.buildPromptText({
        message,
        rawText: textWithTranscription,
        ingestPlan,
      });

      const stopTyping = await this.startTypingIndicator({
        channel,
        peerId,
        sessionKey,
        agentId,
      });
      await this.emitPhaseSafely({
        channel,
        peerId,
        phase: "thinking",
        payload: { sessionKey, agentId, messageId: message.id },
      });

      const supportsStreaming = typeof channel.editMessage === "function";
      let streamingBuffer: StreamingBuffer | undefined;

      try {
        await this.agentManager.ensureChannelContext({ sessionKey, agentId, message });

        if (supportsStreaming) {
          streamingBuffer = new StreamingBuffer(channel, peerId, (err) => {
            logger.warn({ err, sessionKey, agentId }, "Streaming buffer error");
          });
          await streamingBuffer.initialize();

          await this.runPromptWithFallback({
            sessionKey,
            agentId,
            text: promptText,
            onStream: (event) => {
              if (event.type === "text_delta" && event.delta) {
                streamingBuffer?.append(event.delta);
              } else if (event.type === "tool_start") {
                void this.emitPhaseSafely({
                  channel,
                  peerId,
                  phase: "executing",
                  payload: {
                    sessionKey,
                    agentId,
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                    messageId: message.id,
                  },
                });
              } else if (event.type === "tool_end") {
                void this.emitPhaseSafely({
                  channel,
                  peerId,
                  phase: "thinking",
                  payload: {
                    sessionKey,
                    agentId,
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                    messageId: message.id,
                  },
                });
              }
            },
          });

          const { agent } = await this.agentManager.getAgent(sessionKey, agentId);
          const messages = agent.messages;
          const lastAssistant = [...messages]
            .toReversed()
            .find((m: { role: string }) => m.role === "assistant");
          const renderOptions = this.resolveReplyRenderOptions(agentId);
          const replyText = renderAssistantReply(
            (lastAssistant as { content?: unknown })?.content,
            renderOptions,
          );

          if (isSilentReplyText(replyText)) {
            logger.info({ sessionKey, agentId }, "Message handling skipped by silent reply token");
            return;
          }

          if (
            message.raw &&
            (message.raw as { source?: string }).source === "heartbeat" &&
            replyText.trim() === "HEARTBEAT_OK"
          ) {
            logger.debug({ sessionKey, agentId }, "Heartbeat reply suppressed");
            return;
          }

          await this.emitPhaseSafely({
            channel,
            peerId,
            phase: "speaking",
            payload: { sessionKey, agentId, messageId: message.id },
          });

          const outboundId = await streamingBuffer.finalize(replyText);
          logger.info(
            {
              sessionKey,
              agentId,
              outboundId,
              replyChars: replyText?.length ?? 0,
              durationMs: Date.now() - startedAt,
              streaming: true,
            },
            "Message handling completed",
          );
        } else {
          await this.runPromptWithFallback({ sessionKey, agentId, text: promptText });

          const { agent } = await this.agentManager.getAgent(sessionKey, agentId);
          const messages = agent.messages;
          const lastAssistant = [...messages]
            .toReversed()
            .find((m: { role: string }) => m.role === "assistant");
          const renderOptions = this.resolveReplyRenderOptions(agentId);
          const replyText = renderAssistantReply(
            (lastAssistant as { content?: unknown })?.content,
            renderOptions,
          );
          if (isSilentReplyText(replyText)) {
            logger.info({ sessionKey, agentId }, "Message handling skipped by silent reply token");
            return;
          }

          if (
            message.raw &&
            (message.raw as { source?: string }).source === "heartbeat" &&
            replyText.trim() === "HEARTBEAT_OK"
          ) {
            logger.debug({ sessionKey, agentId }, "Heartbeat reply suppressed");
            return;
          }

          await this.emitPhaseSafely({
            channel,
            peerId,
            phase: "speaking",
            payload: { sessionKey, agentId, messageId: message.id },
          });

          const outbound: OutboundMessage = planOutboundByNegotiation({
            channelId: channel.id,
            text: replyText || "(no response)",
            inboundPlan: ingestPlan,
          });
          const outboundId = await channel.send(peerId, outbound);
          logger.info(
            {
              sessionKey,
              agentId,
              outboundId,
              replyChars: outbound.text?.length ?? 0,
              durationMs: Date.now() - startedAt,
            },
            "Message handling completed",
          );
        }
      } finally {
        if (capability.restoreModelRef) {
          try {
            await this.agentManager.setSessionModel(sessionKey, capability.restoreModelRef);
          } catch (error) {
            logger.warn(
              {
                err: error,
                sessionKey,
                agentId,
                restoreModelRef: capability.restoreModelRef,
              },
              "Failed to restore pre-routing session model",
            );
          }
        }
        await this.emitPhaseSafely({
          channel,
          peerId,
          phase: "idle",
          payload: { sessionKey, agentId, messageId: message.id },
        });
        await this.stopTypingIndicator({
          stop: stopTyping,
          sessionKey,
          agentId,
          peerId,
        });
      }
    } catch (error) {
      const err = this.toError(error);
      await this.emitPhaseSafely({
        channel,
        peerId,
        phase: "error",
        payload: { sessionKey, agentId, messageId: message.id },
      });
      if (this.isAbortError(err)) {
        logger.warn({ sessionKey, agentId, error: err.message }, "Message handling aborted");
        return;
      }
      logger.error({ err, sessionKey }, "Failed to handle message");
      try {
        if (this.isMissingAuthError(err.message)) {
          const key = this.parseMissingAuthKey(err.message);
          const guidance = key
            ? `Missing authentication secret ${key}. Set it with /setAuth set ${key}=<value> [--scope=agent|global].`
            : "Missing authentication secret. Set it with /setAuth set KEY=<value> [--scope=agent|global].";
          await channel.send(peerId, { text: guidance });
          return;
        }
        await channel.send(peerId, {
          text: `Sorry, an error occurred while processing the message: ${err.message}`,
        });
      } catch {}
      throw err;
    }
  }

  async handleInternalMessage(params: {
    sessionKey: string;
    content: string;
    source: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const { sessionKey, content, source, metadata } = params;

    logger.info(
      {
        sessionKey,
        source,
        metadata,
        contentChars: content.length,
      },
      "Handling internal message",
    );

    try {
      const parts = sessionKey.split(":");
      const agentId = parts[1] || "mozi";

      await this.runPromptWithFallback({
        sessionKey,
        agentId,
        text: content,
      });

      logger.info({ sessionKey, agentId, source }, "Internal message processed");
    } catch (err) {
      logger.error({ err, sessionKey, source }, "Failed to handle internal message");
      throw err;
    }
  }
}
