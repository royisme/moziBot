import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { MoziConfig } from "../../config";
import type { ChannelPlugin } from "../adapters/channels/plugin";
import type { InboundMessage } from "../adapters/channels/types";
import type { SessionManager } from "./sessions/manager";
import { AgentManager, ModelRegistry, ProviderRegistry, SessionStore } from "..";
import { logger } from "../../logger";
import {
  type ResolvedMemoryPersistenceConfig,
} from "../../memory/backend-config";
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
  waitForAgentIdle,
  type PromptAgent,
} from "./message-handler/services/prompt-runner";
import { maybePreFlushBeforePrompt as maybePreFlushBeforePromptService } from "./message-handler/services/preflush-gate";
import { resolveCurrentReasoningLevel as resolveCurrentReasoningLevelService } from "./message-handler/services/reasoning-level";
import {
  toError as toErrorService,
} from "./message-handler/services/error-utils";
import { flushMemoryWithLifecycle as flushMemoryWithLifecycleService } from "./message-handler/services/memory-flush";
import { runPromptWithCoordinator as runPromptWithCoordinatorService } from "./message-handler/services/prompt-coordinator";
import { buildOrchestratorDeps as buildOrchestratorDepsService } from "./message-handler/services/orchestrator-deps-builder";
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
  parseInlineOverrides as _unusedParseInlineOverridesService,
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
  finalizeStreamingReply as _unusedFinalizeStreamingReply,
  buildNegotiatedOutbound as _unusedBuildNegotiatedOutbound,
  sendNegotiatedReply as _unusedSendNegotiatedReply,
} from "./message-handler/services/reply-dispatcher";
import {
  resolveLastAssistantReplyText as _unusedResolveLastAssistantReplyText,
  shouldSuppressHeartbeatReply as _unusedShouldSuppressHeartbeatReply,
  shouldSuppressSilentReply as _unusedShouldSuppressSilentReply,
} from "./message-handler/services/reply-finalizer";
import {
  StreamingBuffer as _unusedTurnStreamingBuffer,
} from "./message-handler/services/streaming";
import {
  emitPhaseSafely as _unusedEmitPhaseSafelyService,
  startTypingIndicator as _unusedStartTypingIndicatorService,
  stopTypingIndicator as _unusedStopTypingIndicatorService,
  type InteractionPhase as _unusedInteractionPhase,
  type PhasePayload as _unusedPhasePayload,
} from "./message-handler/services/interaction-lifecycle";
import {
  createErrorReplyText as _unusedCreateErrorReplyTextService,
} from "./message-handler/services/error-reply";
import { resolveReplyRenderOptionsFromConfig as _unusedResolveReplyRenderOptionsFromConfig } from "./message-handler/render/reasoning";
import { checkInputCapability as _unusedCheckInputCapabilityService } from "./message-handler/services/capability";

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
    await runPromptWithCoordinatorService({
      ...params,
      config: this.config,
      logger,
      agentManager: this.agentManager as unknown as {
        getAgent(sessionKey: string, agentId: string): Promise<{
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
        getContextUsage(sessionKey: string):
          | {
              usedTokens: number;
              totalTokens: number;
              percentage: number;
            }
          | null;
      },
      activeMap: this.activePromptRuns,
      interruptedSet: this.interruptedPromptRuns,
      flushMemory: async (sessionKey, agentId, messages, config) =>
        await this.flushMemory(sessionKey, agentId, messages, config),
    });
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
    return buildOrchestratorDepsService({
      channel,
      config: this.config,
      logger,
      sessions: this.sessions,
      agentManager: this.agentManager,
      modelRegistry: this.modelRegistry,
      mediaPreprocessor: this.mediaPreprocessor,
      lastRoutes: this.lastRoutes,
      latestPromptMessages: this.latestPromptMessages,
      resolveSessionContext: (message) => this.resolveSessionContext(message),
      parseCommand: (text) => this.parseCommand(text),
      normalizeImplicitControlCommand: (text) => this.normalizeImplicitControlCommand(text),
      createCommandHandlerMap: (targetChannel) => this.createCommandHandlerMap(targetChannel),
      runPromptWithFallback: async (params) => await this.runPromptWithFallback(params),
      maybePreFlushBeforePrompt: async (params) => await this.maybePreFlushBeforePrompt(params),
    });
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
