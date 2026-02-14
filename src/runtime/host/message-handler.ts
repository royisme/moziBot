import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";
import path from "node:path";
import type { MoziConfig } from "../../config";
import type { DeliveryPlan } from "../../multimodal/capabilities";
import type { ChannelPlugin } from "../adapters/channels/plugin";
import type { InboundMessage } from "../adapters/channels/types";
import type { SecretScope } from "../auth/types";
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
import { buildProviderInputPayload } from "../../multimodal/provider-payload";
import { createRuntimeSecretBroker } from "../auth/broker";
import {
  isContextOverflowError,
  isCompactionFailureError,
  estimateMessagesTokens,
} from "../context-management";
import { isTransientError } from "../core/error-policy";
import { SubagentRegistry } from "../subagent-registry";
import { handleRemindersCommand as handleRemindersCommandService } from "./message-handler/services/reminders-command";
import { getAssistantFailureReason, type ReplyRenderOptions } from "./reply-utils";
import { RuntimeRouter } from "./router";
import { buildSessionKey } from "./session-key";
import { SubAgentRegistry as SessionSubAgentRegistry } from "./sessions/spawn";
import { InboundMediaPreprocessor } from "../media-understanding/preprocess";
import { createSessionTools } from "./tools/sessions";
import {
  parseCommand as parseCommandService,
  normalizeImplicitControlCommand as normalizeImplicitControlCommandService,
} from "./commands/parser";
import {
  handleThinkCommand,
  handleReasoningCommand,
  parseInlineOverrides as parseInlineOverridesService,
} from "./commands/reasoning";
import type { ReasoningLevel } from "../model/thinking";
import {
  handleStatusCommand as handleStatusCommandService,
  handleContextCommand as handleContextCommandService,
} from "./commands/session";
import type { OrchestratorDeps } from "./message-handler/contract";
import { createMessageTurnContext } from "./message-handler/context";
import { MessageTurnOrchestrator } from "./message-handler/orchestrator";
import {
  type CommandHandlerMap,
} from "./message-handler/services/command-handlers";
import { buildMessageCommandHandlerMap } from "./message-handler/services/command-registry";
import {
  finalizeStreamingReply,
  buildNegotiatedOutbound,
  sendNegotiatedReply,
} from "./message-handler/services/reply-dispatcher";
import {
  resolveLastAssistantReplyText,
  shouldSuppressHeartbeatReply,
  shouldSuppressSilentReply,
} from "./message-handler/services/reply-finalizer";
import {
  StreamingBuffer as TurnStreamingBuffer,
} from "./message-handler/services/streaming";
import {
  emitPhaseSafely as emitPhaseSafelyService,
  startTypingIndicator as startTypingIndicatorService,
  stopTypingIndicator as stopTypingIndicatorService,
  type InteractionPhase,
  type PhasePayload,
} from "./message-handler/services/interaction-lifecycle";
import {
  toError as toErrorService,
  isAbortError as isAbortErrorService,
  createErrorReplyText as createErrorReplyTextService,
} from "./message-handler/services/error-reply";
import { resolveReplyRenderOptionsFromConfig } from "./message-handler/render/reasoning";
import { checkInputCapability as checkInputCapabilityService } from "./message-handler/services/capability";

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
  private latestPromptMessages = new Map<
    string,
    import("./message-handler/services/reply-finalizer").AssistantMessageShape[]
  >();
  private config: MoziConfig;
  private runtimeControl?: RuntimeControl;
  private mediaPreprocessor: InboundMediaPreprocessor;
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
    this.mediaPreprocessor = new InboundMediaPreprocessor(config);
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
    this.mediaPreprocessor.updateConfig(config);
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
    await handleStatusCommandService({
      sessionKey,
      agentId,
      message,
      channel,
      peerId,
      agentManager: this.agentManager,
      runtimeControl: this.runtimeControl,
      resolveCurrentReasoningLevel: (targetSessionKey, targetAgentId) =>
        this.resolveCurrentReasoningLevel(targetSessionKey, targetAgentId),
      version: this.getVersion(),
    });
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
    agentId: string;
    channel: ChannelPlugin;
    peerId: string;
  }): Promise<void> {
    const { sessionKey, agentId, channel, peerId } = params;
    await handleContextCommandService({
      sessionKey,
      agentId,
      channel,
      peerId,
      config: this.config,
      agentManager: this.agentManager,
    });
  }

  private resolveCurrentReasoningLevel(sessionKey: string, agentId: string): ReasoningLevel {
    const metadata = this.agentManager.getSessionMetadata(sessionKey) as
      | { reasoningLevel?: ReasoningLevel }
      | undefined;
    if (metadata?.reasoningLevel) {
      return metadata.reasoningLevel;
    }

    const agents = (this.config.agents || {}) as Record<string, unknown>;
    const defaults =
      (agents.defaults as { output?: { reasoningLevel?: ReasoningLevel } } | undefined)?.output ||
      undefined;
    const entry =
      (agents[agentId] as { output?: { reasoningLevel?: ReasoningLevel } } | undefined)?.output ||
      undefined;
    return entry?.reasoningLevel ?? defaults?.reasoningLevel ?? "off";
  }

  private async maybePreFlushBeforePrompt(params: {
    sessionKey: string;
    agentId: string;
  }): Promise<void> {
    const { sessionKey, agentId } = params;
    const memoryConfig = resolveMemoryBackendConfig({ cfg: this.config, agentId });
    if (!memoryConfig.persistence.enabled || !memoryConfig.persistence.onOverflowCompaction) {
      return;
    }

    const usage = this.agentManager.getContextUsage(sessionKey);
    if (!usage || usage.percentage < 80) {
      return;
    }

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
        trigger: "pre_overflow",
      },
    });
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
      | "stop"
      | "restart"
      | "compact"
      | "context"
      | "setauth"
      | "unsetauth"
      | "listauth"
      | "checkauth"
      | "reminders"
      | "heartbeat"
      | "think"
      | "reasoning";
    args: string;
  } | null {
    return parseCommandService(text);
  }

  private normalizeImplicitControlCommand(text: string): string | null {
    return normalizeImplicitControlCommandService(text);
  }

  private async handleHeartbeatCommand(params: {
    agentId: string;
    channel: ChannelPlugin;
    peerId: string;
    args: string;
  }): Promise<void> {
    const { agentId, channel, peerId, args } = params;
    const action = args.trim().toLowerCase() || "status";
    const enabledDirective = await this.readHeartbeatEnabledDirective(agentId);
    const effectiveEnabled = enabledDirective ?? true;

    if (action === "status") {
      await channel.send(peerId, {
        text: `Heartbeat is currently ${effectiveEnabled ? "enabled" : "disabled"} for agent ${agentId}. (source: HEARTBEAT.md directive)`,
      });
      return;
    }

    if (action === "off" || action === "pause" || action === "stop" || action === "disable") {
      const ok = await this.writeHeartbeatEnabledDirective(agentId, false);
      await channel.send(peerId, {
        text: ok
          ? `Heartbeat disabled for agent ${agentId} by updating HEARTBEAT.md.`
          : `Failed to update HEARTBEAT.md for agent ${agentId}.`,
      });
      return;
    }

    if (action === "on" || action === "resume" || action === "start" || action === "enable") {
      const ok = await this.writeHeartbeatEnabledDirective(agentId, true);
      await channel.send(peerId, {
        text: ok
          ? `Heartbeat enabled for agent ${agentId} by updating HEARTBEAT.md.`
          : `Failed to update HEARTBEAT.md for agent ${agentId}.`,
      });
      return;
    }

    await channel.send(peerId, {
      text: "Usage: /heartbeat [status|on|off]",
    });
  }

  private getHeartbeatFilePath(agentId: string): string | null {
    const workspaceDir = this.agentManager.getWorkspaceDir(agentId);
    if (!workspaceDir) {
      return null;
    }
    return path.join(workspaceDir, "HEARTBEAT.md");
  }

  private async readHeartbeatEnabledDirective(agentId: string): Promise<boolean | null> {
    const filePath = this.getHeartbeatFilePath(agentId);
    if (!filePath) {
      return null;
    }
    let content = "";
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      return null;
    }

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      const matched = trimmed.match(/^@heartbeat\s+enabled\s*=\s*(on|off|true|false)$/i);
      if (!matched) {
        continue;
      }
      const value = matched[1]?.toLowerCase();
      return value === "on" || value === "true";
    }
    return null;
  }

  private async writeHeartbeatEnabledDirective(
    agentId: string,
    enabled: boolean,
  ): Promise<boolean> {
    const filePath = this.getHeartbeatFilePath(agentId);
    if (!filePath) {
      return false;
    }

    let content = "";
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      content = "# HEARTBEAT.md\n\n";
    }

    const directiveLine = `@heartbeat enabled=${enabled ? "on" : "off"}`;
    const lines = content.split("\n");
    let replaced = false;
    const nextLines = lines.map((line) => {
      if (/^\s*@heartbeat\s+enabled\s*=\s*(on|off|true|false)\s*$/i.test(line)) {
        replaced = true;
        return directiveLine;
      }
      return line;
    });

    let nextContent = nextLines.join("\n");
    if (!replaced) {
      nextContent = `${directiveLine}\n${nextContent}`;
    }

    try {
      await fs.writeFile(filePath, nextContent, "utf-8");
      return true;
    } catch (error) {
      logger.warn(
        {
          agentId,
          filePath,
          error: this.toError(error).message,
        },
        "Failed to update HEARTBEAT.md directive",
      );
      return false;
    }
  }

  private async handleRemindersCommand(params: {
    sessionKey: string;
    message: InboundMessage;
    channel: ChannelPlugin;
    peerId: string;
    args: string;
  }): Promise<void> {
    await handleRemindersCommandService(params);
  }

  private async runPromptWithFallback(params: {
    sessionKey: string;
    agentId: string;
    text: string;
    onStream?: StreamingCallback;
    onFallback?: (info: {
      fromModel: string;
      toModel: string;
      attempt: number;
      error: string;
    }) => Promise<void> | void;
  }): Promise<void> {
    const { sessionKey, agentId, text, onStream, onFallback } = params;
    const fallbacks = this.agentManager.getAgentFallbacks(agentId);
    const tried = new Set<string>();
    const transientRetryCounts = new Map<string, number>();
    let attempt = 0;
    let overflowCompactionAttempts = 0;

    try {
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
        const activeToolCalls = new Map<string, { toolName: string; startedAt: number }>();

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
              if (event.type === "tool_execution_start") {
                const eventStartedAt = Date.now();
                activeToolCalls.set(event.toolCallId, {
                  toolName: event.toolName,
                  startedAt: eventStartedAt,
                });
                logger.info(
                  {
                    sessionKey,
                    agentId,
                    modelRef,
                    attempt,
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                    elapsedMsFromPromptStart: eventStartedAt - startedAt,
                  },
                  "Agent tool execution started",
                );
              } else if (event.type === "tool_execution_end") {
                const endedAt = Date.now();
                const started = activeToolCalls.get(event.toolCallId);
                const toolDurationMs = started ? endedAt - started.startedAt : undefined;
                activeToolCalls.delete(event.toolCallId);
                logger.info(
                  {
                    sessionKey,
                    agentId,
                    modelRef,
                    attempt,
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                    isError: event.isError,
                    toolDurationMs,
                    elapsedMsFromPromptStart: endedAt - startedAt,
                  },
                  "Agent tool execution ended",
                );
              }
              void this.handleAgentStreamEvent(event, onStream, (text) => {
                accumulatedText = text;
              });
            });
          }

          const runAbortController = new AbortController();
          let aborted = false;
          const abortRun = (reason?: unknown): void => {
            if (aborted) {
              return;
            }
            aborted = true;
            runAbortController.abort(reason);
            if (typeof agent.abort === "function") {
              void Promise.resolve(agent.abort()).catch((abortError) => {
                logger.warn(
                  {
                    sessionKey,
                    agentId,
                    modelRef,
                    attempt,
                    error: this.toError(abortError).message,
                  },
                  "Agent abort failed after timeout",
                );
              });
            }
          };
          const abortable = async <T>(promise: Promise<T>): Promise<T> => {
            const signal = runAbortController.signal;
            if (signal.aborted) {
              throw this.toError(signal.reason ?? new Error("Agent prompt aborted"));
            }

            return await new Promise<T>((resolve, reject) => {
              const onAbort = () => {
                reject(this.toError(signal.reason ?? new Error("Agent prompt aborted")));
              };

              signal.addEventListener("abort", onAbort, { once: true });
              promise.then(
                (value) => {
                  signal.removeEventListener("abort", onAbort);
                  resolve(value);
                },
                (err) => {
                  signal.removeEventListener("abort", onAbort);
                  reject(err);
                },
              );
            });
          };
          const promptTimeoutMs = this.agentManager.resolvePromptTimeoutMs(agentId);
          const timeoutHandle = setTimeout(() => {
            abortRun(new Error("Agent prompt timeout"));
          }, promptTimeoutMs);

          try {
            await abortable(Promise.resolve(agent.prompt(text)));
          } finally {
            clearTimeout(timeoutHandle);
          }

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

          const modelSpec = this.modelRegistry.get(modelRef);
          const latestAssistant = [...((agent.messages as unknown[]) || [])]
            .toReversed()
            .find((m) =>
              Boolean(m && typeof m === "object" && (m as { role?: unknown }).role === "assistant"),
            );
          const latestAssistantRecord =
            latestAssistant && typeof latestAssistant === "object"
              ? (latestAssistant as Record<string, unknown>)
              : undefined;
          const assistantStopReason =
            latestAssistantRecord && typeof latestAssistantRecord.stopReason === "string"
              ? latestAssistantRecord.stopReason
              : undefined;
          const assistantErrorMessage =
            latestAssistantRecord && typeof latestAssistantRecord.errorMessage === "string"
              ? latestAssistantRecord.errorMessage
              : undefined;
          const assistantFailureReason = getAssistantFailureReason(latestAssistantRecord);
          const content = latestAssistantRecord?.content;
          const assistantContentKind = Array.isArray(content) ? "array" : typeof content;
          const isJsonParseError = /unexpected non-whitespace character after json/i.test(
            err.message,
          );
          const isTimeoutError = err.message === "Agent prompt timeout";
          const inFlightToolCalls = Array.from(activeToolCalls.entries()).map(
            ([toolCallId, entry]) => ({
              toolCallId,
              toolName: entry.toolName,
              elapsedMs: Date.now() - entry.startedAt,
            }),
          );

          logger.warn(
            {
              sessionKey,
              agentId,
              modelRef,
              attempt,
              elapsedMs: Date.now() - startedAt,
              errorName: err.name,
              error: err.message,
              isTimeoutError,
              isJsonParseError,
              provider: modelSpec?.provider,
              modelApi: modelSpec?.api,
              baseUrl: modelSpec?.baseUrl,
              hasAssistantMessage: Boolean(latestAssistantRecord),
              assistantStopReason,
              assistantErrorMessage,
              assistantFailureReason,
              assistantContentKind,
              inFlightToolCalls,
              fallbackCandidates: fallbacks.filter(
                (fallback) => fallback !== modelRef && !tried.has(fallback),
              ),
            },
            "Agent prompt attempt failed diagnostics",
          );

          const errorText = err.message || String(err);
          if (isContextOverflowError(errorText) && !isCompactionFailureError(errorText)) {
            if (overflowCompactionAttempts < MessageHandler.MAX_OVERFLOW_COMPACTION_ATTEMPTS) {
              overflowCompactionAttempts++;
              logger.warn(
                { sessionKey, agentId, attempt: overflowCompactionAttempts },
                "Context overflow detected, triggering auto-compaction",
              );

              const memoryConfig = resolveMemoryBackendConfig({ cfg: this.config, agentId });
              if (
                memoryConfig.persistence.enabled &&
                memoryConfig.persistence.onOverflowCompaction
              ) {
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

          if (isTransientError(errorText) && !isTimeoutError) {
            const transientAttempts = transientRetryCounts.get(modelRef) ?? 0;
            if (transientAttempts < 2) {
              transientRetryCounts.set(modelRef, transientAttempts + 1);
              const delayMs = 1000 * 2 ** transientAttempts;
              logger.warn(
                { sessionKey, agentId, modelRef, attempt, transientAttempts: transientAttempts + 1, delayMs },
                "Transient error, retrying current model after backoff",
              );
              await new Promise((r) => setTimeout(r, delayMs));
              continue;
            }
          }

          tried.add(modelRef);
          const nextFallback = fallbacks.find((m) => !tried.has(m));
          if (!nextFallback) {
            throw err;
          }
          const nextFallbackSpec = this.modelRegistry.get(nextFallback);
          logger.warn(
            {
              sessionKey,
              agentId,
              fromModel: modelRef,
              fromModelApi: modelSpec?.api,
              fromProvider: modelSpec?.provider,
              toModel: nextFallback,
              toModelApi: nextFallbackSpec?.api,
              toProvider: nextFallbackSpec?.provider,
              attempt,
              error: err.message,
            },
            "Agent prompt failed, switching to fallback model",
          );
          await this.agentManager.setSessionModel(sessionKey, nextFallback, { persist: false });
          await onFallback?.({
            fromModel: modelRef,
            toModel: nextFallback,
            attempt,
            error: err.message,
          });
        } finally {
          if (unsubscribe) {
            unsubscribe();
          }
          this.clearActivePromptRun(sessionKey);
          clearInterval(progressTimer);
        }
      }
    } finally {
      this.agentManager.clearRuntimeModelOverride(sessionKey);
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

  getActivePromptRunCount(): number {
    return this.activePromptRuns.size;
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

  private isAgentBusyError(error: unknown): boolean {
    const normalized = this.toError(error);
    return normalized.message.toLowerCase().includes("already processing a prompt");
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

  private modelConfigHint(agentId: string, input: "image" | "audio" | "video" | "file"): string {
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
    const currentBeforeRouting = await this.agentManager.getAgent(
      params.sessionKey,
      params.agentId,
    );
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

  private createCommandHandlerMap(channel: ChannelPlugin): CommandHandlerMap {
    return buildMessageCommandHandlerMap({
      channel: {
        send: async (peerId, payload) => {
          await channel.send(peerId, payload);
        },
      },
      onWhoami: async ({ message, peerId }) => {
        await this.handleWhoamiCommand({ message, channel, peerId });
      },
      onStatus: async ({ sessionKey, agentId, message, peerId }) => {
        await this.handleStatusCommand({ sessionKey, agentId, message, channel, peerId });
      },
      onNew: async ({ sessionKey, agentId, peerId }) => {
        await this.handleNewSessionCommand(sessionKey, agentId, channel, peerId);
      },
      onModels: async ({ sessionKey, agentId, peerId }) => {
        await this.handleModelsCommand(sessionKey, agentId, channel, peerId);
      },
      onSwitch: async ({ sessionKey, agentId, peerId, args }) => {
        await this.handleSwitchCommand(sessionKey, agentId, args, channel, peerId);
      },
      onStop: async ({ sessionKey, peerId }) => {
        const interrupted = await this.interruptSession(sessionKey, "Stopped by /stop command");
        await channel.send(peerId, {
          text: interrupted
            ? "Stopped active run. You can now /switch and continue."
            : "No active run to stop.",
        });
      },
      onRestart: async ({ peerId }) => {
        await this.handleRestartCommand(channel, peerId);
      },
      onCompact: async ({ sessionKey, agentId, peerId }) => {
        await this.handleCompactCommand({ sessionKey, agentId, channel, peerId });
      },
      onContext: async ({ sessionKey, agentId, peerId }) => {
        await this.handleContextCommand({ sessionKey, agentId, channel, peerId });
      },
      onThink: async ({ sessionKey, agentId, peerId, args }) => {
        await handleThinkCommand({
          agentManager: this.agentManager,
          sessionKey,
          agentId,
          channel,
          peerId,
          args,
        });
      },
      onReasoning: async ({ sessionKey, peerId, args }) => {
        await handleReasoningCommand({
          agentManager: this.agentManager,
          sessionKey,
          channel,
          peerId,
          args,
        });
      },
      onSetAuth: async ({ agentId, message, peerId, args }) => {
        await this.handleAuthCommand({
          args: `set ${args}`.trim(),
          agentId,
          senderId: message.senderId,
          channel,
          peerId,
        });
      },
      onUnsetAuth: async ({ agentId, message, peerId, args }) => {
        await this.handleAuthCommand({
          args: `unset ${args}`.trim(),
          agentId,
          senderId: message.senderId,
          channel,
          peerId,
        });
      },
      onListAuth: async ({ agentId, message, peerId, args }) => {
        await this.handleAuthCommand({
          args: `list ${args}`.trim(),
          agentId,
          senderId: message.senderId,
          channel,
          peerId,
        });
      },
      onCheckAuth: async ({ agentId, message, peerId, args }) => {
        await this.handleAuthCommand({
          args: `check ${args}`.trim(),
          agentId,
          senderId: message.senderId,
          channel,
          peerId,
        });
      },
      onReminders: async ({ sessionKey, message, peerId, args }) => {
        await this.handleRemindersCommand({ sessionKey, message, channel, peerId, args });
      },
      onHeartbeat: async ({ agentId, peerId, args }) => {
        await this.handleHeartbeatCommand({ agentId, channel, peerId, args });
      },
    });
  }

  private createOrchestratorDeps(channel: ChannelPlugin): OrchestratorDeps {
    const lifecycleChannel = {
      beginTyping: channel.beginTyping
        ? async (peerId: string) => (await channel.beginTyping!(peerId)) ?? undefined
        : undefined,
      emitPhase: channel.emitPhase
        ? async (
            peerId: string,
            phase: InteractionPhase,
            payload?: PhasePayload,
          ) => {
            await channel.emitPhase!(peerId, phase, payload);
          }
        : undefined,
    };

    const streamingChannel = {
      send: (peerId: string, message: Parameters<ChannelPlugin["send"]>[1]) =>
        channel.send(peerId, message),
      editMessage: async (messageId: string, peerId: string, text: string) => {
        if (channel.editMessage) {
          await channel.editMessage(messageId, peerId, text);
        }
      },
    };

    return {
      config: this.config,
      logger,
      getText: (payload) => this.getText(payload as InboundMessage),
      getMedia: (payload) => (payload as InboundMessage).media || [],
      normalizeImplicitControlCommand: (text) => this.normalizeImplicitControlCommand(text) ?? text,
      parseCommand: (text) => this.parseCommand(text),
      parseInlineOverrides: (parsedCommand) =>
        parseInlineOverridesService(
          parsedCommand
            ? {
                name: parsedCommand.name as
                  | "start"
                  | "help"
                  | "status"
                  | "whoami"
                  | "new"
                  | "models"
                  | "switch"
                  | "stop"
                  | "restart"
                  | "compact"
                  | "context"
                  | "setauth"
                  | "unsetauth"
                  | "listauth"
                  | "checkauth"
                  | "reminders"
                  | "heartbeat"
                  | "think"
                  | "reasoning",
                args: parsedCommand.args,
              }
            : null,
        ),
      resolveSessionContext: (payload) => this.resolveSessionContext(payload as InboundMessage),
      rememberLastRoute: (agentId, payload) => {
        const message = payload as InboundMessage;
        this.lastRoutes.set(agentId, {
          channelId: message.channel,
          peerId: message.peerId,
          peerType: message.peerType ?? "dm",
          accountId: message.accountId,
          threadId: message.threadId,
        });
      },
      sendDirect: async (peerId, text) => {
        await channel.send(peerId, { text });
      },
      getCommandHandlerMap: () => this.createCommandHandlerMap(channel),
      getChannel: () => ({
        id: channel.id,
        editMessage: channel.editMessage,
        send: (peerId, message) => channel.send(peerId, message),
      }),
      resetSession: (sessionKey, agentId) => {
        this.agentManager.resetSession(sessionKey, agentId);
      },
      getSessionTimestamps: (sessionKey) => {
        const session =
          this.sessions.get(sessionKey) ||
          this.sessions.getOrCreate(sessionKey, this.agentManager.resolveDefaultAgentId());
        const now = Date.now();
        return {
          createdAt: session?.createdAt ?? now,
          updatedAt: session?.updatedAt,
        };
      },
      getSessionMetadata: (sessionKey) => {
        const fromAgentManager = this.agentManager.getSessionMetadata(sessionKey);
        if (fromAgentManager && Object.keys(fromAgentManager).length > 0) {
          return fromAgentManager;
        }
        const fromSessionStore = this.sessions.get(sessionKey)?.metadata;
        if (fromSessionStore && Object.keys(fromSessionStore).length > 0) {
          return fromSessionStore;
        }
        const fromSessionStoreCreated = this.sessions.getOrCreate(
          sessionKey,
          this.agentManager.resolveDefaultAgentId(),
        ).metadata;
        return fromSessionStoreCreated || {};
      },
      updateSessionMetadata: (sessionKey, meta) => {
        this.agentManager.updateSessionMetadata(sessionKey, meta);
      },
      revertToPreviousSegment: (sessionKey, agentId) =>
        Boolean(this.sessions.revertToPreviousSegment(sessionKey, agentId)),
      getConfigAgents: () => (this.config.agents || {}) as Record<string, unknown>,
      getSessionMessages: (sessionKey) => {
        const latest = this.latestPromptMessages.get(sessionKey);
        if (latest && latest.length > 0) {
          return latest;
        }
        const existing = this.sessions.get(sessionKey)?.context;
        if (Array.isArray(existing) && existing.length > 0) {
          return existing as import("./message-handler/services/reply-finalizer").AssistantMessageShape[];
        }
        const created = this.sessions.getOrCreate(
          sessionKey,
          this.agentManager.resolveDefaultAgentId(),
        ).context;
        return (created || []) as import("./message-handler/services/reply-finalizer").AssistantMessageShape[];
      },
      transcribeInboundMessage: async (payload) => {
        const result = await this.mediaPreprocessor.preprocessInboundMessage(
          payload as InboundMessage,
        );
        return result.transcript ?? undefined;
      },
      checkInputCapability: async ({ sessionKey, agentId, message, peerId, hasAudioTranscript }) => {
        return await checkInputCapabilityService({
          sessionKey,
          agentId,
          peerId,
          hasAudioTranscript,
          media: ((message as InboundMessage).media || []).map((item, index) => ({
            type: item.type,
            mediaId: `media-${index + 1}`,
          })),
          deps: {
            logger,
            channel: {
              send: async (targetPeerId, payload) => {
                await channel.send(targetPeerId, payload);
              },
            },
            agentManager: {
              getAgent: async (targetSessionKey, targetAgentId) => {
                const current = await this.agentManager.getAgent(targetSessionKey, targetAgentId);
                return { modelRef: current.modelRef };
              },
              ensureSessionModelForInput: async ({ sessionKey, agentId, input }) => {
                const routed = await this.agentManager.ensureSessionModelForInput({
                  sessionKey,
                  agentId,
                  input,
                });
                if (routed.ok) {
                  return {
                    ok: true,
                    switched: routed.switched,
                    modelRef: routed.modelRef,
                    candidates: [],
                  };
                }
                return {
                  ok: false,
                  switched: false,
                  modelRef: routed.modelRef,
                  candidates: routed.candidates,
                };
              },
            },
          },
        });
      },
      ingestInboundMessage: async ({ message, sessionKey, agentId }) => {
        const inbound = message as InboundMessage;
        const current = await this.agentManager.getAgent(sessionKey, agentId);
        const modelSpec = this.modelRegistry.get(current.modelRef);
        return ingestInboundMessage({
          message: inbound,
          sessionKey,
          channelId: inbound.channel,
          modelRef: current.modelRef,
          modelSpec,
        });
      },
      buildPromptText: ({ message, rawText, transcript, ingestPlan }) => {
        const combined = this.buildRawTextWithTranscription(rawText, transcript ?? null);
        return this.buildPromptText({
          message: message as InboundMessage,
          rawText: combined,
          ingestPlan: ingestPlan as DeliveryPlan | null | undefined,
        });
      },
      ensureChannelContext: async ({ sessionKey, agentId, message }) => {
        await this.agentManager.ensureChannelContext({
          sessionKey,
          agentId,
          message: message as InboundMessage,
        });
      },
      startTypingIndicator: async ({ sessionKey, agentId, peerId }) => {
        return await startTypingIndicatorService({
          channel: lifecycleChannel,
          peerId,
          sessionKey,
          agentId,
          deps: { logger, toError: toErrorService },
        });
      },
      emitPhaseSafely: async ({ phase, payload }) => {
        const resolvedPeerId = payload.agentId
          ? this.lastRoutes.get(payload.agentId)?.peerId
          : undefined;
        if (!resolvedPeerId) {
          return;
        }
        await emitPhaseSafelyService({
          channel: lifecycleChannel,
          peerId: resolvedPeerId,
          phase,
          payload,
          deps: { logger, toError: toErrorService },
        });
      },
      createStreamingBuffer: ({ peerId, onError }) =>
        new TurnStreamingBuffer(streamingChannel, peerId, onError),
      runPromptWithFallback: async ({ sessionKey, agentId, text, onStream, onFallback }) => {
        await this.runPromptWithFallback({
          sessionKey,
          agentId,
          text,
          onStream,
          onFallback,
        });
        const current = await this.agentManager.getAgent(sessionKey, agentId);
        this.latestPromptMessages.set(
          sessionKey,
          current.agent.messages as import("./message-handler/services/reply-finalizer").AssistantMessageShape[],
        );
      },
      maybePreFlushBeforePrompt: async ({ sessionKey, agentId }) => {
        await this.maybePreFlushBeforePrompt({ sessionKey, agentId });
      },
      resolveReplyRenderOptions: (agentId) =>
        resolveReplyRenderOptionsFromConfig(agentId, (this.config.agents || {}) as Record<string, unknown>),
      resolveLastAssistantReplyText: ({ messages, renderOptions }) =>
        resolveLastAssistantReplyText({ messages, renderOptions }),
      shouldSuppressSilentReply: (text) => shouldSuppressSilentReply(text),
      shouldSuppressHeartbeatReply: (raw, text) =>
        shouldSuppressHeartbeatReply(raw as { source?: string } | undefined, text),
      finalizeStreamingReply: async ({ buffer, replyText }) =>
        finalizeStreamingReply({ buffer, replyText }),
      buildNegotiatedOutbound: ({ channelId, replyText, inboundPlan }) =>
        buildNegotiatedOutbound({ channelId, replyText, inboundPlan }),
      sendNegotiatedReply: async ({ peerId, outbound }) =>
        sendNegotiatedReply({ channel, peerId, outbound }),
      toError: (err) => toErrorService(err),
      isAbortError: (err) => isAbortErrorService(err),
      createErrorReplyText: (err) => createErrorReplyTextService(err),
      setSessionModel: async (sessionKey, modelRef) => {
        await this.agentManager.setSessionModel(sessionKey, modelRef);
      },
      stopTypingIndicator: async ({ stop, sessionKey, agentId, peerId }) => {
        await stopTypingIndicatorService({
          stop,
          sessionKey,
          agentId,
          peerId,
          deps: { logger, toError: toErrorService },
        });
      },
    };
  }

  async handle(message: InboundMessage, channel: ChannelPlugin): Promise<void> {
    const input: import("./message-handler/types").MessageTurnInput = {
      id: message.id,
      type: "message",
      payload: message,
    };
    const context = createMessageTurnContext(input);
    const orchestrator = new MessageTurnOrchestrator(this.createOrchestratorDeps(channel));
    await orchestrator.handle(context);
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
