import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { MoziConfig } from "../../config";
import type { DeliveryPlan } from "../../multimodal/capabilities";
import type { ChannelPlugin } from "../adapters/channels/plugin";
import type { InboundMessage } from "../adapters/channels/types";
import type { SessionManager } from "./sessions/manager";
import { AgentManager, ModelRegistry, ProviderRegistry, SessionStore } from "..";
import { logger } from "../../logger";
import {
  resolveMemoryBackendConfig,
  type ResolvedMemoryPersistenceConfig,
} from "../../memory/backend-config";
import { type FlushMetadata } from "../../memory/flush-manager";
import { ingestInboundMessage } from "../../multimodal/ingest";
import {
  isContextOverflowError,
  isCompactionFailureError,
  estimateMessagesTokens,
} from "../context-management";
import { isTransientError } from "../core/error-policy";
import { SubagentRegistry } from "../subagent-registry";
import { handleRemindersCommand as handleRemindersCommandService } from "./message-handler/services/reminders-command";
import { handleHeartbeatCommand as handleHeartbeatCommandService } from "./message-handler/services/heartbeat-command";
import { handleAuthCommand as handleAuthCommandService } from "./message-handler/services/auth-command";
import {
  handleModelsCommand as handleModelsCommandService,
  handleSwitchCommand as handleSwitchCommandService,
} from "./message-handler/services/models-command";
import {
  handleCompactCommand as handleCompactCommandService,
  handleNewSessionCommand as handleNewSessionCommandService,
  handleRestartCommand as handleRestartCommandService,
} from "./message-handler/services/session-control-command";
import {
  runPromptWithFallback as runPromptWithFallbackService,
  waitForAgentIdle,
  type PromptAgent,
} from "./message-handler/services/prompt-runner";
import {
  buildPromptText as buildPromptTextService,
  buildRawTextWithTranscription as buildRawTextWithTranscriptionService,
} from "./message-handler/services/prompt-text";
import { maybePreFlushBeforePrompt as maybePreFlushBeforePromptService } from "./message-handler/services/preflush-gate";
import { resolveCurrentReasoningLevel as resolveCurrentReasoningLevelService } from "./message-handler/services/reasoning-level";
import {
  isAbortError as isAbortErrorService,
  isAgentBusyError as isAgentBusyErrorService,
  toError as toErrorService,
} from "./message-handler/services/error-utils";
import { flushMemoryWithLifecycle as flushMemoryWithLifecycleService } from "./message-handler/services/memory-flush";
import {
  resolveSessionMessages as resolveSessionMessagesService,
  resolveSessionMetadata as resolveSessionMetadataService,
  resolveSessionTimestamps as resolveSessionTimestampsService,
} from "./message-handler/services/orchestrator-session";
import { getAssistantFailureReason } from "./reply-utils";
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
  parseInlineOverrides as parseInlineOverridesService,
} from "./commands/reasoning";
import type { ReasoningLevel } from "../model/thinking";
import {
  handleWhoamiCommand as handleWhoamiCommandService,
  handleStatusCommand as handleStatusCommandService,
  handleContextCommand as handleContextCommandService,
} from "./commands/session";
import type { OrchestratorDeps } from "./message-handler/contract";
import { createMessageTurnContext } from "./message-handler/context";
import { MessageTurnOrchestrator } from "./message-handler/orchestrator";
import {
  type CommandHandlerMap,
} from "./message-handler/services/command-handlers";
import { buildCommandHandlerMap as buildCommandHandlerMapService } from "./message-handler/services/command-map-builder";
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
  private static readonly INTERRUPT_WAIT_TIMEOUT_MS = 5_000;
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

  private async handleModelsCommand(
    sessionKey: string,
    agentId: string,
    channel: ChannelPlugin,
    peerId: string,
  ): Promise<void> {
    await handleModelsCommandService({
      sessionKey,
      agentId,
      channel,
      peerId,
      agentManager: this.agentManager,
      modelRegistry: this.modelRegistry,
    });
  }

  private async handleSwitchCommand(
    sessionKey: string,
    agentId: string,
    args: string,
    channel: ChannelPlugin,
    peerId: string,
  ): Promise<void> {
    await handleSwitchCommandService({
      sessionKey,
      agentId,
      args,
      channel,
      peerId,
      agentManager: this.agentManager,
      modelRegistry: this.modelRegistry,
    });
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

  private async handleNewSessionCommand(
    sessionKey: string,
    agentId: string,
    channel: ChannelPlugin,
    peerId: string,
  ): Promise<void> {
    await handleNewSessionCommandService({
      sessionKey,
      agentId,
      channel,
      peerId,
      config: this.config,
      agentManager: this.agentManager,
      flushMemory: async (targetSessionKey, targetAgentId, messages, config) =>
        await this.flushMemory(targetSessionKey, targetAgentId, messages, config),
    });
  }

  private async handleRestartCommand(channel: ChannelPlugin, peerId: string): Promise<void> {
    await handleRestartCommandService({
      channel,
      peerId,
      runtimeControl: this.runtimeControl,
    });
  }

  private async handleCompactCommand(params: {
    sessionKey: string;
    agentId: string;
    channel: ChannelPlugin;
    peerId: string;
  }): Promise<void> {
    const { sessionKey, agentId, channel, peerId } = params;
    await handleCompactCommandService({
      sessionKey,
      agentId,
      channel,
      peerId,
      agentManager: this.agentManager,
    });
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
    return resolveCurrentReasoningLevelService({
      sessionMetadata: this.agentManager.getSessionMetadata(sessionKey) as
        | { reasoningLevel?: ReasoningLevel }
        | undefined,
      agentsConfig: (this.config.agents || {}) as Record<string, unknown>,
      agentId,
    });
  }

  private async maybePreFlushBeforePrompt(params: {
    sessionKey: string;
    agentId: string;
  }): Promise<void> {
    const { sessionKey, agentId } = params;
    await maybePreFlushBeforePromptService({
      sessionKey,
      agentId,
      config: this.config,
      agentManager: this.agentManager,
      flushMemory: async (targetSessionKey, targetAgentId, messages, config) =>
        await this.flushMemory(targetSessionKey, targetAgentId, messages, config),
    });
  }

  private async handleWhoamiCommand(params: {
    message: InboundMessage;
    channel: ChannelPlugin;
    peerId: string;
  }): Promise<void> {
    await handleWhoamiCommandService(params);
  }

  private async handleAuthCommand(params: {
    args: string;
    agentId: string;
    senderId: string;
    channel: ChannelPlugin;
    peerId: string;
  }): Promise<void> {
    const { args, agentId, senderId, channel, peerId } = params;
    await handleAuthCommandService({
      args,
      agentId,
      senderId,
      channel,
      peerId,
      config: this.config,
      toError: (error) => toErrorService(error),
    });
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
    await handleHeartbeatCommandService({
      agentId,
      channel,
      peerId,
      args,
      resolveWorkspaceDir: (targetAgentId) => this.agentManager.getWorkspaceDir(targetAgentId) ?? null,
      logger,
      toError: (error) => toErrorService(error),
    });
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
    await runPromptWithFallbackService({
      sessionKey,
      agentId,
      text,
      onStream,
      onFallback,
      onContextOverflow: async (attempt) => {
        logger.warn(
          { sessionKey, agentId, attempt },
          "Context overflow detected, triggering auto-compaction",
        );

        const { agent } = await this.agentManager.getAgent(sessionKey, agentId);
        const memoryConfig = resolveMemoryBackendConfig({ cfg: this.config, agentId });
        if (memoryConfig.persistence.enabled && memoryConfig.persistence.onOverflowCompaction) {
          const meta = this.agentManager.getSessionMetadata(sessionKey)?.memoryFlush as
            | FlushMetadata
            | undefined;
          if (!meta || meta.lastAttemptedCycle < attempt) {
            const success = await this.flushMemory(
              sessionKey,
              agentId,
              agent.messages,
              memoryConfig.persistence,
            );
            this.agentManager.updateSessionMetadata(sessionKey, {
              memoryFlush: {
                lastAttemptedCycle: attempt,
                lastTimestamp: Date.now(),
                lastStatus: success ? "success" : "failure",
                trigger: "overflow",
              },
            });
          }
        }

        const compactResult = await this.agentManager.compactSession(sessionKey, agentId);
        if (!compactResult.success) {
          logger.warn({ sessionKey, reason: compactResult.reason }, "Auto-compaction failed");
          throw new Error("Auto-compaction failed");
        }
        logger.info(
          { sessionKey, tokensReclaimed: compactResult.tokensReclaimed },
          "Auto-compaction succeeded, retrying prompt",
        );
      },
      deps: {
        logger,
        agentManager: {
          getAgent: async (targetSessionKey, targetAgentId) => {
            const current = await this.agentManager.getAgent(targetSessionKey, targetAgentId);
            return { agent: current.agent as PromptAgent, modelRef: current.modelRef };
          },
          getAgentFallbacks: (targetAgentId) => this.agentManager.getAgentFallbacks(targetAgentId),
          setSessionModel: async (targetSessionKey, modelRef, options) => {
            await this.agentManager.setSessionModel(targetSessionKey, modelRef, options);
          },
          clearRuntimeModelOverride: (targetSessionKey) =>
            this.agentManager.clearRuntimeModelOverride(targetSessionKey),
          resolvePromptTimeoutMs: (targetAgentId) =>
            this.agentManager.resolvePromptTimeoutMs(targetAgentId),
        },
        errorClassifiers: {
          isAgentBusyError: (err) => isAgentBusyErrorService(err),
          isContextOverflowError: (message) =>
            isContextOverflowError(message) && !isCompactionFailureError(message),
          isAbortError: (error) => isAbortErrorService(error),
          isTransientError: (message) => isTransientError(message),
          toError: (err) => toErrorService(err),
        },
      },
      activeMap: this.activePromptRuns,
      interruptedSet: this.interruptedPromptRuns,
    });

    const current = await this.agentManager.getAgent(sessionKey, agentId);
    const latestAssistant = [...(current.agent.messages as Array<{ role?: string }>)].toReversed().find(
      (m) => m && m.role === "assistant",
    );
    const failureReason = getAssistantFailureReason(latestAssistant);
    if (failureReason) {
      throw new Error(failureReason);
    }
    this.agentManager.updateSessionContext(sessionKey, current.agent.messages);
    const usage = this.agentManager.getContextUsage(sessionKey);
    if (usage) {
      logger.debug(
        {
          sessionKey,
          agentId,
          responseTokens: latestAssistant ? estimateMessagesTokens([latestAssistant as AgentMessage]) : 0,
          totalContextTokens: usage.usedTokens,
          contextWindow: usage.totalTokens,
          fillPercentage: usage.percentage,
        },
        "Prompt completed with usage stats",
      );
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
          error: toErrorService(error).message,
        },
        "Interrupt wait ended with error",
      );
      return true;
    }
  }

  private async waitForAgentIdle(agent: ActivePromptAgent, timeoutMs?: number): Promise<void> {
    await waitForAgentIdle(agent as PromptAgent, timeoutMs);
  }

  private async flushMemory(
    sessionKey: string,
    agentId: string,
    messages: AgentMessage[],
    config: ResolvedMemoryPersistenceConfig,
  ): Promise<boolean> {
    return await flushMemoryWithLifecycleService({
      config: this.config,
      sessionKey,
      agentId,
      messages,
      persistence: config,
      logger,
    });
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
    return buildCommandHandlerMapService({
      channel,
      agentManager: this.agentManager,
      interruptSession: async (sessionKey, reason) => await this.interruptSession(sessionKey, reason),
      handleWhoamiCommand: async (params) => await this.handleWhoamiCommand(params),
      handleStatusCommand: async (params) => await this.handleStatusCommand(params),
      handleNewSessionCommand: async (sessionKey, agentId, targetChannel, peerId) =>
        await this.handleNewSessionCommand(sessionKey, agentId, targetChannel, peerId),
      handleModelsCommand: async (sessionKey, agentId, targetChannel, peerId) =>
        await this.handleModelsCommand(sessionKey, agentId, targetChannel, peerId),
      handleSwitchCommand: async (sessionKey, agentId, args, targetChannel, peerId) =>
        await this.handleSwitchCommand(sessionKey, agentId, args, targetChannel, peerId),
      handleRestartCommand: async (targetChannel, peerId) =>
        await this.handleRestartCommand(targetChannel, peerId),
      handleCompactCommand: async (params) => await this.handleCompactCommand(params),
      handleContextCommand: async (params) => await this.handleContextCommand(params),
      handleAuthCommand: async (params) => await this.handleAuthCommand(params),
      handleRemindersCommand: async (params) => await this.handleRemindersCommand(params),
      handleHeartbeatCommand: async (params) => await this.handleHeartbeatCommand(params),
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
      getText: (payload) => ((payload as InboundMessage).text || "").toString(),
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
        return resolveSessionTimestampsService({
          sessionKey,
          sessions: this.sessions,
          agentManager: this.agentManager,
        });
      },
      getSessionMetadata: (sessionKey) => {
        return resolveSessionMetadataService({
          sessionKey,
          sessions: this.sessions,
          agentManager: this.agentManager,
        });
      },
      updateSessionMetadata: (sessionKey, meta) => {
        this.agentManager.updateSessionMetadata(sessionKey, meta);
      },
      revertToPreviousSegment: (sessionKey, agentId) =>
        Boolean(this.sessions.revertToPreviousSegment(sessionKey, agentId)),
      getConfigAgents: () => (this.config.agents || {}) as Record<string, unknown>,
      getSessionMessages: (sessionKey) => {
        return resolveSessionMessagesService({
          sessionKey,
          sessions: this.sessions,
          agentManager: this.agentManager,
          latestPromptMessages: this.latestPromptMessages,
        });
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
        const combined = buildRawTextWithTranscriptionService(rawText, transcript ?? null);
        return buildPromptTextService({
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
