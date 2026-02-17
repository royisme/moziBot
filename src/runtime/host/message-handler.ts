import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { MoziConfig } from "../../config";
import type { ChannelPlugin } from "../adapters/channels/plugin";
import type { InboundMessage } from "../adapters/channels/types";
import type { OrchestratorDeps } from "./message-handler/contract";
import type { SessionManager } from "./sessions/manager";
import { AgentManager, ModelRegistry, ProviderRegistry, SessionStore } from "..";
import { logger } from "../../logger";
import { type ResolvedMemoryPersistenceConfig } from "../../memory/backend-config";
import { configureMemoryMaintainerHooks } from "../hooks/bundled/memory-maintainer";
import { InboundMediaPreprocessor } from "../media-understanding/preprocess";
import { SubagentRegistry } from "../subagent-registry";
import { parseCommand, normalizeImplicitControlCommand } from "./commands/parser";
import { parseInlineOverrides as _unusedParseInlineOverridesService } from "./commands/reasoning";
import { createMessageTurnContext } from "./message-handler/context";
import { MessageTurnOrchestrator } from "./message-handler/orchestrator";
import { checkInputCapability as _unusedCheckInputCapabilityService } from "./message-handler/services/capability";
import { type CommandHandlerMap } from "./message-handler/services/command-handlers";
import { buildCommandHandlerMap as buildCommandHandlerMapService } from "./message-handler/services/command-map-builder";
import { createErrorReplyText as _unusedCreateErrorReplyTextService } from "./message-handler/services/error-reply";
import { toError as toErrorService } from "./message-handler/services/error-utils";
import {
  emitPhaseSafely as _unusedEmitPhaseSafelyService,
  startTypingIndicator as _unusedStartTypingIndicatorService,
  stopTypingIndicator as _unusedStopTypingIndicatorService,
  type InteractionPhase as _unusedInteractionPhase,
  type PhasePayload as _unusedPhasePayload,
} from "./message-handler/services/interaction-lifecycle";
import { flushMemoryWithLifecycle as flushMemoryWithLifecycleService } from "./message-handler/services/memory-flush";
import {
  resolveSessionContext as resolveSessionContextService,
  type LastRoute,
} from "./message-handler/services/message-router";
import { buildOrchestratorDeps as buildOrchestratorDepsService } from "./message-handler/services/orchestrator-deps-builder";
import { maybePreFlushBeforePrompt as maybePreFlushBeforePromptService } from "./message-handler/services/preflush-gate";
import { toPromptCoordinatorAgentManager } from "./message-handler/services/prompt-agent-manager-adapter";
import { runPromptWithCoordinator as runPromptWithCoordinatorService } from "./message-handler/services/prompt-coordinator";
import { waitForAgentIdle, type PromptAgent } from "./message-handler/services/prompt-runner";
import { dispatchReply as _unusedDispatchReply } from "./message-handler/services/reply-dispatcher";
import {
  shouldSuppressHeartbeatReply as _unusedShouldSuppressHeartbeatReply,
  shouldSuppressSilentReply as _unusedShouldSuppressSilentReply,
} from "./message-handler/services/reply-finalizer";
import { StreamingBuffer as _unusedTurnStreamingBuffer } from "./message-handler/services/streaming";
import { RuntimeRouter } from "./router";
import { SubAgentRegistry as SessionSubAgentRegistry } from "./sessions/spawn";
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
    configureMemoryMaintainerHooks(config);
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
    configureMemoryMaintainerHooks(config);
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

  private getVersion(): string {
    return "1.0.2";
  }

  private async runPromptWithFallback(params: {
    sessionKey: string;
    agentId: string;
    text: string;
    traceId?: string;
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
      agentManager: toPromptCoordinatorAgentManager(this.agentManager),
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
      await waitForAgentIdle(active.agent as PromptAgent, MessageHandler.INTERRUPT_WAIT_TIMEOUT_MS);
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

  private createCommandHandlerMap(channel: ChannelPlugin): CommandHandlerMap {
    return buildCommandHandlerMapService({
      channel,
      agentManager: this.agentManager,
      modelRegistry: this.modelRegistry,
      config: this.config,
      runtimeControl: this.runtimeControl,
      logger,
      getVersion: () => this.getVersion(),
      flushMemory: async (sessionKey, agentId, messages, config) =>
        await this.flushMemory(sessionKey, agentId, messages, config),
      interruptSession: async (sessionKey, reason) =>
        await this.interruptSession(sessionKey, reason),
      resolveWorkspaceDir: (agentId) => this.agentManager.getWorkspaceDir(agentId) ?? null,
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
      resolveSessionContext: (message) =>
        resolveSessionContextService({
          message,
          router: this.router,
          defaultAgentId: this.agentManager.resolveDefaultAgentId(),
        }),
      parseCommand: (text) => parseCommand(text),
      normalizeImplicitControlCommand: (text) => normalizeImplicitControlCommand(text),
      createCommandHandlerMap: (targetChannel) => this.createCommandHandlerMap(targetChannel),
      runPromptWithFallback: async (params) => await this.runPromptWithFallback(params),
      maybePreFlushBeforePrompt: async ({ sessionKey, agentId }) =>
        await maybePreFlushBeforePromptService({
          sessionKey,
          agentId,
          config: this.config,
          agentManager: this.agentManager,
          flushMemory: async (targetSessionKey, targetAgentId, messages, config) =>
            await this.flushMemory(targetSessionKey, targetAgentId, messages, config),
        }),
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
        traceId: `internal:${source}:${Date.now()}`,
      });

      logger.info({ sessionKey, agentId, source }, "Internal message processed");
    } catch (err) {
      logger.error({ err, sessionKey, source }, "Failed to handle internal message");
      throw err;
    }
  }
}
