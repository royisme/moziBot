import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { AgentManager, ModelRegistry, ProviderRegistry, SessionStore } from "..";
import { AcpSessionManager } from "../../acp/control-plane";
import type { MoziConfig } from "../../config";
import { logger } from "../../logger";
import { type ResolvedMemoryPersistenceConfig } from "../../memory/backend-config";
import type { ChannelPlugin } from "../adapters/channels/plugin";
import type { InboundMessage } from "../adapters/channels/types";
import type { PromptMode } from "../agent-manager/prompt-builder";
import { configureMemoryMaintainerHooks } from "../hooks/bundled/memory-maintainer";
import { InboundMediaPreprocessor } from "../media-understanding/preprocess";
import { SubagentRegistry, type HostSubagentRuntime } from "../subagent-registry";
import { createSendMediaTool } from "../tools/send-media";
import { parseCommand, normalizeImplicitControlCommand } from "./commands/parser";
import { parseInlineOverrides as _unusedParseInlineOverridesService } from "./commands/reasoning";
import { createMessageTurnContext } from "./message-handler/context";
import type { OrchestratorDeps } from "./message-handler/contract";
import { MessageTurnOrchestrator } from "./message-handler/orchestrator";
import { checkInputCapability as _unusedCheckInputCapabilityService } from "./message-handler/services/capability";
import { type CommandHandlerMap } from "./message-handler/services/command-handlers";
import { buildCommandHandlerMap as buildCommandHandlerMapService } from "./message-handler/services/command-map-builder";
import { createErrorReplyText as _unusedCreateErrorReplyTextService } from "./message-handler/services/error-reply";
import {
  isAbortError as isAbortErrorService,
  toError as toErrorService,
} from "./message-handler/services/error-utils";
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
import { resolveSessionMetadata as resolveSessionMetadataService } from "./message-handler/services/orchestrator-session";
import { maybePreFlushBeforePrompt as maybePreFlushBeforePromptService } from "./message-handler/services/preflush-gate";
import { toPromptCoordinatorAgentManager } from "./message-handler/services/prompt-agent-manager-adapter";
import { runPromptWithCoordinator as runPromptWithCoordinatorService } from "./message-handler/services/prompt-coordinator";
import { waitForAgentIdle, type PromptAgent } from "./message-handler/services/prompt-runner";
import { dispatchReply as _unusedDispatchReply } from "./message-handler/services/reply-dispatcher";
import {
  shouldSuppressHeartbeatReply as _unusedShouldSuppressHeartbeatReply,
  shouldSuppressSilentReply as _unusedShouldSuppressSilentReply,
} from "./message-handler/services/reply-finalizer";
import {
  RunLifecycleRegistry,
  type RunLifecycleEntry,
  type RunTerminal,
} from "./message-handler/services/run-lifecycle-registry";
import { performSessionReset } from "./message-handler/services/session-control-command";
import { emitStatusReactionSafely as _unusedEmitStatusReactionSafelyService } from "./message-handler/services/status-reaction";
import { StreamingBuffer as _unusedTurnStreamingBuffer } from "./message-handler/services/streaming";
import { extractAssistantText } from "./reply-utils";
import { RuntimeRouter } from "./router";
import type { RouteContext } from "./routing/types";
import type { SessionManager } from "./sessions/manager";
import { DetachedRunRegistry as SessionDetachedRunRegistry } from "./sessions/spawn";
import { createBrowserTools } from "./tools/browser";
import { createSessionTools } from "./tools/sessions";

/**
 * Callback interface for streaming agent responses to channels.
 * Called during agent execution to deliver real-time updates.
 */
export type StreamingCallback = (event: {
  type: "text_delta" | "tool_start" | "tool_end" | "agent_end";
  runId?: string;
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
  messages?: AgentMessage[];
};

export type DetachedRunHandle = {
  runId: string;
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
      abortRun?: (reason?: unknown) => void;
    }
  >();
  private interruptedPromptRuns = new Set<string>();
  private detachedTerminalCallbacks = new Map<
    string,
    (params: {
      entry: RunLifecycleEntry;
      terminal: RunTerminal;
      partialText?: string;
      error?: Error;
      reason?: string;
      errorCode?: string;
    }) => Promise<void> | void
  >();
  private runLifecycle = new RunLifecycleRegistry({
    onTerminal: (entry, payload) => {
      const callback = this.detachedTerminalCallbacks.get(entry.runId);
      const errorCode =
        payload.errorCode ??
        (payload.error && typeof (payload.error as unknown as { code?: unknown }).code === "string"
          ? ((payload.error as unknown as { code: string }).code ?? undefined)
          : undefined);
      const logPayload = {
        runId: entry.runId,
        sessionKey: entry.sessionKey,
        traceId: entry.traceId,
        terminal: payload.state,
        reason: payload.reason,
        errorCode,
      };
      if (payload.state === "failed") {
        logger.warn(logPayload, "Detached run terminal observed");
      } else {
        logger.info(logPayload, "Detached run terminal observed");
      }
      if (!callback) {
        return;
      }
      queueMicrotask(() => {
        void Promise.resolve(
          callback({
            entry,
            terminal: payload.state,
            partialText: payload.partialText,
            error: payload.error,
            reason: payload.reason,
            errorCode,
          }),
        ).catch((error) => {
          const err = toErrorService(error);
          logger.error(
            {
              runId: entry.runId,
              sessionKey: entry.sessionKey,
              traceId: entry.traceId,
              error: err.message,
            },
            "Detached terminal callback failed",
          );
        });
      });
    },
  });

  private config: MoziConfig;
  private runtimeControl?: RuntimeControl;
  private hostSessionManager?: SessionManager;
  private hostDetachedRunRegistry?: SessionDetachedRunRegistry;
  private mediaPreprocessor: InboundMediaPreprocessor;

  getAgentManager(): AgentManager {
    return this.agentManager;
  }

  getSessionTimestamps(sessionKey: string): { createdAt?: number; updatedAt?: number } | null {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return null;
    }
    return {
      createdAt: session.createdAt ?? Date.now(),
      updatedAt: session.updatedAt,
    };
  }

  getLastRoute(agentId: string): RouteContext | undefined {
    return this.lastRoutes.get(agentId);
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
      detachedRunRegistry?: SessionDetachedRunRegistry;
      runtimeControl?: RuntimeControl;
    },
  ) {
    this.config = config;
    configureMemoryMaintainerHooks(config);
    this.runtimeControl = deps?.runtimeControl;
    this.hostSessionManager = deps?.sessionManager;
    this.hostDetachedRunRegistry = deps?.detachedRunRegistry;
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
      this.createHostSubagentRuntime(deps?.sessionManager, deps?.detachedRunRegistry),
    );
    this.agentManager.setSubagentRegistry(this.subagents);
    this.agentManager.setToolProvider((params) => {
      const tools: ReturnType<typeof createSessionTools> = [];

      if (deps?.sessionManager && deps?.detachedRunRegistry) {
        tools.push(
          ...createSessionTools({
            sessionManager: deps.sessionManager,
            detachedRunRegistry: deps.detachedRunRegistry,
            currentSessionKey: params.sessionKey,
            config: this.config,
          }),
          ...createBrowserTools({
            getConfig: () => this.config,
          }),
        );
      }

      tools.push(
        createSendMediaTool({
          workspaceDir: params.workspaceDir,
          getChannel: () => this.agentManager.getSessionContext(params.sessionKey)?.channel,
          getPeerId: () => this.agentManager.getSessionContext(params.sessionKey)?.peerId,
        }),
      );

      return tools;
    });
  }

  /**
   * Hot-reload configuration without losing agent state
   */
  private createHostSubagentRuntime(
    sessionManager?: SessionManager,
    detachedRunRegistry?: SessionDetachedRunRegistry,
  ): HostSubagentRuntime | undefined {
    if (!sessionManager || !detachedRunRegistry) {
      return undefined;
    }

    return {
      sessionManager,
      detachedRunRegistry,
      startDetachedPromptRun: async ({
        runId,
        sessionKey,
        agentId,
        text,
        traceId,
        promptMode,
        modelRef,
        timeoutSeconds,
        onAccepted,
        onTerminal,
      }) => {
        const active = await this.agentManager.getAgent(sessionKey, agentId, {
          ...(promptMode ? { promptMode } : {}),
          ...(modelRef ? { model: modelRef } : {}),
        });
        const sessionMetadata = resolveSessionMetadataService({
          sessionKey,
          sessions: this.sessions,
          agentManager: this.agentManager,
        });
        const acpMetadata =
          sessionMetadata && typeof sessionMetadata === "object" && "acp" in sessionMetadata
            ? (sessionMetadata.acp as Record<string, unknown> | undefined)
            : undefined;
        const isAcpDetachedRun = Boolean(acpMetadata);
        const sessionRecord = sessionManager.get(sessionKey);
        const parentKey = sessionRecord?.parentKey;
        if (isAcpDetachedRun && parentKey && !detachedRunRegistry.get(runId)) {
          detachedRunRegistry.register({
            runId,
            kind: "acp",
            childKey: sessionKey,
            parentKey,
            task: text,
            cleanup: "keep",
            timeoutSeconds,
          });
        }
        this.runLifecycle.createRun({
          runId,
          sessionKey,
          agentId,
          traceId,
          modelRef: active.modelRef,
        });
        if (onTerminal) {
          this.detachedTerminalCallbacks.set(runId, async (params) => {
            await onTerminal({
              terminal: params.terminal,
              partialText: params.partialText,
              error: params.error,
              reason: params.reason,
              errorCode: params.errorCode,
            });
          });
        }
        queueMicrotask(() => {
          void (async () => {
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            const lifecycleTerminated = () => {
              const lifecycleRun = this.runLifecycle.getRun(runId);
              return (
                lifecycleRun?.state === "completed" ||
                lifecycleRun?.state === "failed" ||
                lifecycleRun?.state === "timeout" ||
                lifecycleRun?.state === "aborted"
              );
            };
            const persistAcpTerminal = async (
              status: "completed" | "failed" | "aborted" | "timeout",
              options: { result?: string; error?: string; endedAt?: number } = {},
            ) => {
              if (!isAcpDetachedRun) {
                return;
              }
              await detachedRunRegistry.setTerminal({
                runId,
                status,
                result: options.result,
                error: options.error,
                endedAt: options.endedAt,
              });
            };
            try {
              this.runLifecycle.markStarted(runId);
              if (isAcpDetachedRun) {
                detachedRunRegistry.markStarted(runId);
              }
              if (
                typeof timeoutSeconds === "number" &&
                Number.isFinite(timeoutSeconds) &&
                timeoutSeconds > 0
              ) {
                timeoutHandle = setTimeout(() => {
                  const reason = isAcpDetachedRun ? "acp-timeout" : "subagent-timeout";
                  const lifecycleEntry = this.runLifecycle.getRun(runId);
                  const endedAt = Date.now();
                  this.runLifecycle.timeoutRun(runId, reason);
                  if (isAcpDetachedRun) {
                    void persistAcpTerminal("timeout", {
                      result: lifecycleEntry?.buffer.snapshot(),
                      error: reason,
                      endedAt,
                    }).catch((error) => {
                      logger.error(
                        {
                          err: error instanceof Error ? error.message : String(error),
                          runId,
                          sessionKey,
                        },
                        "Failed to persist ACP detached run timeout",
                      );
                    });
                  }
                }, timeoutSeconds * 1000);
                timeoutHandle.unref?.();
              }
              await onAccepted?.();
              if (isAcpDetachedRun) {
                const acpSessionManager = new AcpSessionManager();
                await acpSessionManager.runTurn({
                  cfg: this.config,
                  sessionKey,
                  text,
                  mode: "prompt",
                  requestId: runId,
                  signal: this.runLifecycle.getRun(runId)?.controller.signal,
                  onEvent: async (event) => {
                    if (event.type === "text_delta" && event.text) {
                      this.runLifecycle.appendDelta(runId, event.text);
                    }
                  },
                  onTerminal: async (terminal) => {
                    const lifecycleEntry = this.runLifecycle.getRun(runId);
                    const partialText = lifecycleEntry?.buffer.snapshot();
                    const terminalError =
                      terminal.error ??
                      (terminal.errorCode
                        ? Object.assign(new Error(terminal.reason ?? terminal.terminal), {
                            code: terminal.errorCode,
                          })
                        : undefined);
                    const endedAt = Date.now();
                    await persistAcpTerminal(terminal.terminal, {
                      result: partialText,
                      error: terminal.reason ?? terminalError?.message,
                      endedAt,
                    });
                    if (lifecycleEntry) {
                      lifecycleEntry.endedAt = endedAt;
                    }
                    this.runLifecycle.setTerminal(runId, {
                      state: terminal.terminal,
                      reason: terminal.reason,
                      error: terminalError,
                      errorCode: terminal.errorCode,
                      partialText,
                    });
                  },
                });
                return;
              }
              await this.runPromptWithFallback({
                sessionKey,
                agentId,
                text,
                traceId,
                promptMode,
              });
              const finalText = await this.resolveLatestAssistantText(sessionKey, agentId);
              this.runLifecycle.finalizeCompleted(runId, finalText || undefined);
            } catch (error) {
              const err = toErrorService(error);
              const lifecycleRun = this.runLifecycle.getRun(runId);
              if (lifecycleTerminated()) {
                return;
              }
              if (isAbortErrorService(err)) {
                const partialText = lifecycleRun?.buffer.snapshot();
                const endedAt = Date.now();
                await persistAcpTerminal("aborted", {
                  result: partialText,
                  error: err.message,
                  endedAt,
                });
                this.runLifecycle.setTerminal(runId, {
                  state: "aborted",
                  reason: err.message,
                  partialText,
                });
              } else {
                const partialText = lifecycleRun?.buffer.snapshot();
                const endedAt = Date.now();
                await persistAcpTerminal("failed", {
                  result: partialText,
                  error: err.message,
                  endedAt,
                });
                this.runLifecycle.finalizeFailed(runId, err);
              }
            } finally {
              if (timeoutHandle) {
                clearTimeout(timeoutHandle);
              }
              this.detachedTerminalCallbacks.delete(runId);
              this.runLifecycle.dispose(runId);
            }
          })();
        });
        return { runId };
      },
      isDetachedRunActive: (runId: string) => Boolean(this.runLifecycle.getRun(runId)),
    };
  }

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
    this.subagents.reconfigure({
      modelRegistry: this.modelRegistry,
      providerRegistry: this.providerRegistry,
      agentManager: this.agentManager,
      hostRuntime: this.createHostSubagentRuntime(
        this.hostSessionManager,
        this.hostDetachedRunRegistry,
      ),
    });
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
    abortSignal?: AbortSignal;
    promptMode?: PromptMode;
  }): Promise<void> {
    const { promptMode, onStream, abortSignal, ...runnerParams } = params;
    const lifecycleRun = this.resolveLifecycleRun(params.sessionKey, params.traceId);
    const effectiveAbortSignal = abortSignal ?? lifecycleRun?.controller.signal;

    await runPromptWithCoordinatorService({
      ...runnerParams,
      onStream: async (event) => {
        if (lifecycleRun && event.type === "text_delta" && event.delta) {
          this.runLifecycle.appendDelta(lifecycleRun.runId, event.delta);
        }
        if (onStream) {
          await onStream(event);
        }
      },
      abortSignal: effectiveAbortSignal,
      config: this.config,
      logger,
      agentManager: toPromptCoordinatorAgentManager(this.agentManager, promptMode),
      activeMap: this.activePromptRuns,
      interruptedSet: this.interruptedPromptRuns,
      flushMemory: async (sessionKey, agentId, messages, config) =>
        await this.flushMemory(sessionKey, agentId, messages, config),
      getTapeService: (sessionKey) => this.agentManager.getTapeService?.(sessionKey) ?? null,
      getTapeStore: () => this.agentManager.getTapeStore?.() ?? null,
    });
  }

  isSessionActive(sessionKey: string): boolean {
    return (
      this.activePromptRuns.has(sessionKey) ||
      Boolean(this.runLifecycle.getRunBySession(sessionKey))
    );
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
    const lifecycleEntry = this.runLifecycle.getRunBySession(sessionKey);
    const active = this.activePromptRuns.get(sessionKey);
    if (!lifecycleEntry && !active) {
      return false;
    }

    if (lifecycleEntry && !lifecycleEntry.controller.signal.aborted) {
      lifecycleEntry.controller.abort(reason);
    }

    if (!active) {
      return this.runLifecycle.abortSession(sessionKey, reason);
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
      if (typeof active.abortRun === "function") {
        active.abortRun(reason);
      } else if (typeof active.agent.abort === "function") {
        await Promise.resolve(active.agent.abort());
      }
      await waitForAgentIdle(active.agent as PromptAgent, MessageHandler.INTERRUPT_WAIT_TIMEOUT_MS);
    } catch (error) {
      logger.warn(
        {
          sessionKey,
          agentId: active.agentId,
          error: toErrorService(error).message,
        },
        "Interrupt wait ended with error",
      );
    }

    this.runLifecycle.abortSession(sessionKey, reason);
    return true;
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
      runPromptWithFallback: async (params) => await this.runPromptWithFallback(params),
      resolveHomeDir: (agentId) => this.agentManager.getHomeDir(agentId) ?? null,
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
      dispatchExtensionCommand: async ({
        commandName,
        args,
        sessionKey,
        agentId,
        peerId,
        message,
        channelId,
      }) =>
        await this.agentManager.dispatchExtensionCommand({
          commandName,
          args,
          sessionKey,
          agentId,
          peerId,
          channelId,
          message,
          sendReply: async (text) => {
            await channel.send(peerId, { text });
          },
        }),
      interruptSession: async (sessionKey, reason) =>
        await this.interruptSession(sessionKey, reason),
      performSessionReset: async ({ sessionKey, agentId, reason }) =>
        await performSessionReset({
          sessionKey,
          agentId,
          config: this.config,
          agentManager: this.agentManager,
          flushMemory: async (targetSessionKey, targetAgentId, messages, config) =>
            await this.flushMemory(targetSessionKey, targetAgentId, messages, config),
          logger,
          reason,
        }),
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

  async startDetachedRun(params: {
    message: InboundMessage;
    channel: ChannelPlugin;
    queueItemId?: string;
    runId?: string;
    onTerminal?: (params: {
      entry: RunLifecycleEntry;
      terminal: RunTerminal;
      partialText?: string;
      error?: Error;
      reason?: string;
      errorCode?: string;
    }) => Promise<void> | void;
  }): Promise<DetachedRunHandle> {
    const route = this.resolveSessionContext(params.message);
    const active = await this.agentManager.getAgent(route.sessionKey, route.agentId);
    const runId = params.runId ?? `run:${params.message.id}`;

    this.runLifecycle.createRun({
      runId,
      sessionKey: route.sessionKey,
      queueItemId: params.queueItemId,
      agentId: route.agentId,
      traceId: `turn:${params.message.id}`,
      modelRef: active.modelRef,
    });
    if (params.onTerminal) {
      this.detachedTerminalCallbacks.set(runId, params.onTerminal);
    }

    queueMicrotask(() => {
      void (async () => {
        this.runLifecycle.markStarted(runId);
        try {
          await this.handle(params.message, params.channel);
          const finalText = await this.resolveLatestAssistantText(route.sessionKey, route.agentId);
          this.runLifecycle.finalizeCompleted(runId, finalText || undefined);
        } catch (error) {
          const err = toErrorService(error);
          if (isAbortErrorService(err)) {
            this.runLifecycle.setTerminal(runId, {
              state: "aborted",
              reason: err.message,
              partialText: this.runLifecycle.getRun(runId)?.buffer.snapshot(),
            });
          } else {
            this.runLifecycle.finalizeFailed(runId, err);
          }
        } finally {
          this.detachedTerminalCallbacks.delete(runId);
          this.runLifecycle.dispose(runId);
        }
      })();
    });

    return { runId };
  }

  resolveSessionContext(message: InboundMessage): {
    sessionKey: string;
    agentId: string;
    dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
    peerId: string;
    route: RouteContext;
  } {
    return resolveSessionContextService({
      message,
      router: this.router,
      defaultAgentId: this.agentManager.resolveDefaultAgentId(),
    });
  }

  private resolveLifecycleRun(sessionKey: string, traceId?: string): RunLifecycleEntry | undefined {
    const run = this.runLifecycle.getRunBySession(sessionKey);
    if (!run) {
      return undefined;
    }
    if (traceId && run.traceId && run.traceId !== traceId) {
      return undefined;
    }
    return run;
  }

  private async resolveLatestAssistantText(sessionKey: string, agentId: string): Promise<string> {
    try {
      const { agent } = await this.agentManager.getAgent(sessionKey, agentId);
      const messages = Array.isArray(agent.messages) ? agent.messages : [];
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i] as AgentMessage | undefined;
        if (message && message.role === "assistant") {
          return extractAssistantText((message as { content?: unknown }).content);
        }
      }
      return "";
    } catch (error) {
      logger.warn(
        {
          sessionKey,
          agentId,
          error: toErrorService(error).message,
        },
        "Failed to resolve latest assistant text",
      );
      return "";
    }
  }

  async runAgentJobPrompt(params: {
    sessionKey: string;
    agentId: string;
    text: string;
    traceId?: string;
    abortSignal?: AbortSignal;
    onStream?: StreamingCallback;
  }): Promise<void> {
    await this.runPromptWithFallback(params);
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
