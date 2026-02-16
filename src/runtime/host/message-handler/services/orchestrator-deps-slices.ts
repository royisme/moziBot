import type { AgentManager, ModelRegistry, SessionStore } from "../../..";
import type { MoziConfig } from "../../../../config";
import type { DeliveryPlan } from "../../../../multimodal/capabilities";
import type { ChannelPlugin } from "../../../adapters/channels/plugin";
import type { InboundMessage } from "../../../adapters/channels/types";
import type { InboundMediaPreprocessor } from "../../../media-understanding/preprocess";
import type { OrchestratorDeps } from "../contract";
import { ingestInboundMessage } from "../../../../multimodal/ingest";
import { parseInlineOverrides } from "../../commands/reasoning";
import { checkInputCapability as checkInputCapabilityService } from "./capability";
import { createErrorReplyText as createErrorReplyTextService } from "./error-reply";
import { isAbortError as isAbortErrorService, toError as toErrorService } from "./error-utils";
import {
  emitPhaseSafely as emitPhaseSafelyService,
  startTypingIndicator as startTypingIndicatorService,
  stopTypingIndicator as stopTypingIndicatorService,
  type InteractionPhase,
  type PhasePayload,
} from "./interaction-lifecycle";
import { resolveSessionMetadata, resolveSessionTimestamps } from "./orchestrator-session";
import { buildPromptText, buildRawTextWithTranscription } from "./prompt-text";
import { dispatchReply } from "./reply-dispatcher";
import { shouldSuppressHeartbeatReply, shouldSuppressSilentReply } from "./reply-finalizer";
import { StreamingBuffer } from "./streaming";

export interface BuilderLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface OrchestratorDepsBuilderParams {
  channel: ChannelPlugin;
  config: MoziConfig;
  logger: BuilderLogger;
  sessions: SessionStore;
  agentManager: AgentManager;
  modelRegistry: ModelRegistry;
  mediaPreprocessor: InboundMediaPreprocessor;
  lastRoutes: Map<
    string,
    {
      channelId: string;
      peerId: string;
      peerType: "dm" | "group" | "channel";
      accountId?: string;
      threadId?: string | number;
    }
  >;
  resolveSessionContext: (message: InboundMessage) => {
    agentId: string;
    sessionKey: string;
    dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
    peerId: string;
  };
  parseCommand: (text: string) => { name: string; args: string } | null;
  normalizeImplicitControlCommand: (text: string) => string | null;
  createCommandHandlerMap: (
    channel: ChannelPlugin,
  ) => ReturnType<OrchestratorDeps["getCommandHandlerMap"]>;
  runPromptWithFallback: (params: {
    sessionKey: string;
    agentId: string;
    text: string;
    traceId?: string;
    onStream?: (event: {
      type: "text_delta" | "tool_start" | "tool_end" | "agent_end";
      delta?: string;
      toolName?: string;
      toolCallId?: string;
      isError?: boolean;
      fullText?: string;
    }) => void | Promise<void>;
    onFallback?: (info: {
      fromModel: string;
      toModel: string;
      attempt: number;
      error: string;
    }) => Promise<void> | void;
  }) => Promise<void>;
  maybePreFlushBeforePrompt: (params: { sessionKey: string; agentId: string }) => Promise<void>;
}

type InboundDeps = Pick<
  OrchestratorDeps,
  | "getText"
  | "getMedia"
  | "normalizeImplicitControlCommand"
  | "parseCommand"
  | "parseInlineOverrides"
  | "resolveSessionContext"
  | "rememberLastRoute"
  | "sendDirect"
  | "getCommandHandlerMap"
  | "getChannel"
>;

type SessionDeps = Pick<
  OrchestratorDeps,
  | "resetSession"
  | "getSessionTimestamps"
  | "getSessionMetadata"
  | "updateSessionMetadata"
  | "revertToPreviousSegment"
  | "getConfigAgents"
>;

type PromptDeps = Pick<
  OrchestratorDeps,
  | "transcribeInboundMessage"
  | "checkInputCapability"
  | "ingestInboundMessage"
  | "buildPromptText"
  | "ensureChannelContext"
  | "startTypingIndicator"
  | "emitPhaseSafely"
  | "createStreamingBuffer"
  | "runPromptWithFallback"
  | "maybePreFlushBeforePrompt"
>;

type ReplyDeps = Pick<
  OrchestratorDeps,
  "shouldSuppressSilentReply" | "shouldSuppressHeartbeatReply" | "dispatchReply"
>;

type ErrorDeps = Pick<
  OrchestratorDeps,
  "toError" | "isAbortError" | "createErrorReplyText" | "setSessionModel" | "stopTypingIndicator"
>;

function buildInboundDeps(params: OrchestratorDepsBuilderParams): InboundDeps {
  const {
    channel,
    lastRoutes,
    resolveSessionContext,
    parseCommand,
    normalizeImplicitControlCommand,
    createCommandHandlerMap,
  } = params;
  return {
    getText: (payload) => ((payload as InboundMessage).text || "").toString(),
    getMedia: (payload) => (payload as InboundMessage).media || [],
    normalizeImplicitControlCommand: (text) => normalizeImplicitControlCommand(text) ?? text,
    parseCommand: (text) => parseCommand(text),
    parseInlineOverrides: (parsedCommand) =>
      parseInlineOverrides(
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
    resolveSessionContext: (payload) => resolveSessionContext(payload as InboundMessage),
    rememberLastRoute: (agentId, payload) => {
      const message = payload as InboundMessage;
      lastRoutes.set(agentId, {
        channelId: message.channel,
        peerId: message.peerId,
        peerType: message.peerType ?? "dm",
        accountId: message.accountId !== undefined ? String(message.accountId) : undefined,
        threadId: message.threadId !== undefined ? String(message.threadId) : undefined,
      });
    },
    sendDirect: async (peerId, text) => {
      await channel.send(peerId, { text });
    },
    getCommandHandlerMap: () => createCommandHandlerMap(channel),
    getChannel: () => {
      const channelLike = {
        id: channel.id,
        send: (peerId: string, message: Parameters<ChannelPlugin["send"]>[1]) =>
          channel.send(peerId, message),
      } as {
        id: string;
        send: (peerId: string, message: Parameters<ChannelPlugin["send"]>[1]) => Promise<string>;
        editMessage?: (messageId: string, peerId: string, text: string) => Promise<void>;
      };

      if (channel.editMessage) {
        channelLike.editMessage = (messageId, peerId, text) =>
          channel.editMessage!(messageId, peerId, text);
      }

      return channelLike;
    },
  };
}

function buildSessionDeps(params: OrchestratorDepsBuilderParams): SessionDeps {
  const { sessions, agentManager, config } = params;
  return {
    resetSession: (sessionKey, agentId) => {
      agentManager.resetSession(sessionKey, agentId);
    },
    getSessionTimestamps: (sessionKey) =>
      resolveSessionTimestamps({ sessionKey, sessions, agentManager }),
    getSessionMetadata: (sessionKey) =>
      resolveSessionMetadata({ sessionKey, sessions, agentManager }),
    updateSessionMetadata: (sessionKey, meta) => {
      agentManager.updateSessionMetadata(sessionKey, meta);
    },
    revertToPreviousSegment: (sessionKey, agentId) =>
      Boolean(sessions.revertToPreviousSegment(sessionKey, agentId)),
    getConfigAgents: () => (config.agents || {}) as Record<string, unknown>,
  };
}

function buildPromptDeps(params: OrchestratorDepsBuilderParams): PromptDeps {
  const {
    channel,
    logger,
    mediaPreprocessor,
    agentManager,
    modelRegistry,
    runPromptWithFallback,
    maybePreFlushBeforePrompt,
    lastRoutes,
  } = params;
  const lifecycleChannel = {
    beginTyping: channel.beginTyping
      ? async (peerId: string) => (await channel.beginTyping!(peerId)) ?? undefined
      : undefined,
    emitPhase: channel.emitPhase
      ? async (peerId: string, phase: InteractionPhase, payload?: PhasePayload) => {
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
    transcribeInboundMessage: async (payload) => {
      const result = await mediaPreprocessor.preprocessInboundMessage(payload as InboundMessage);
      return result.transcript ?? undefined;
    },
    checkInputCapability: async ({ sessionKey, agentId, message, peerId, hasAudioTranscript }) =>
      await checkInputCapabilityService({
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
              const current = await agentManager.getAgent(targetSessionKey, targetAgentId);
              return { modelRef: current.modelRef };
            },
            ensureSessionModelForInput: async ({ sessionKey, agentId, input }) => {
              const routed = await agentManager.ensureSessionModelForInput({
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
      }),
    ingestInboundMessage: async ({ message, sessionKey, agentId }) => {
      const inbound = message as InboundMessage;
      const current = await agentManager.getAgent(sessionKey, agentId);
      const modelSpec = modelRegistry.get(current.modelRef);
      return ingestInboundMessage({
        message: inbound,
        sessionKey,
        channelId: inbound.channel,
        modelRef: current.modelRef,
        modelSpec,
      });
    },
    buildPromptText: ({ message, rawText, transcript, ingestPlan }) => {
      const combined = buildRawTextWithTranscription(rawText, transcript ?? null);
      return buildPromptText({
        message: message as InboundMessage,
        rawText: combined,
        ingestPlan: ingestPlan as DeliveryPlan | null | undefined,
      });
    },
    ensureChannelContext: async ({ sessionKey, agentId, message }) => {
      await agentManager.ensureChannelContext({
        sessionKey,
        agentId,
        message: message as InboundMessage,
      });
    },
    startTypingIndicator: async ({ sessionKey, agentId, peerId }) =>
      await startTypingIndicatorService({
        channel: lifecycleChannel,
        peerId,
        sessionKey,
        agentId,
        deps: { logger, toError: toErrorService },
      }),
    emitPhaseSafely: async ({ phase, payload }) => {
      const resolvedPeerId = payload.agentId ? lastRoutes.get(payload.agentId)?.peerId : undefined;
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
    createStreamingBuffer: ({ peerId, onError, traceId }) =>
      new StreamingBuffer(streamingChannel, peerId, onError, traceId),
    runPromptWithFallback: async ({ sessionKey, agentId, text, traceId, onStream, onFallback }) => {
      await runPromptWithFallback({ sessionKey, agentId, text, traceId, onStream, onFallback });
    },
    maybePreFlushBeforePrompt: async ({ sessionKey, agentId }) => {
      await maybePreFlushBeforePrompt({ sessionKey, agentId });
    },
  };
}

function buildReplyDeps(params: OrchestratorDepsBuilderParams): ReplyDeps {
  const { channel } = params;
  return {
    shouldSuppressSilentReply: (text) => shouldSuppressSilentReply(text),
    shouldSuppressHeartbeatReply: (raw, text) =>
      shouldSuppressHeartbeatReply(raw as { source?: string } | undefined, text),
    dispatchReply: async ({ peerId, channelId, replyText, inboundPlan, traceId }) =>
      dispatchReply({
        channel,
        peerId,
        channelId,
        replyText,
        inboundPlan,
        traceId,
        showThinking: channel.id === "localDesktop",
      }),
  };
}

function buildErrorDeps(params: OrchestratorDepsBuilderParams): ErrorDeps {
  const { agentManager, logger } = params;
  return {
    toError: (err) => toErrorService(err),
    isAbortError: (err) => isAbortErrorService(err),
    createErrorReplyText: (err) => createErrorReplyTextService(err),
    setSessionModel: async (sessionKey, modelRef) => {
      await agentManager.setSessionModel(sessionKey, modelRef);
    },
    stopTypingIndicator: async ({ stop, sessionKey, agentId, peerId }) =>
      await stopTypingIndicatorService({
        stop,
        sessionKey,
        agentId,
        peerId,
        deps: { logger, toError: toErrorService },
      }),
  };
}

export function composeOrchestratorDeps(params: OrchestratorDepsBuilderParams): OrchestratorDeps {
  return {
    config: params.config,
    logger: params.logger,
    ...buildInboundDeps(params),
    ...buildSessionDeps(params),
    ...buildPromptDeps(params),
    ...buildReplyDeps(params),
    ...buildErrorDeps(params),
  };
}
