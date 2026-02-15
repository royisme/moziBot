import type { DeliveryPlan } from "../../../../multimodal/capabilities";
import { ingestInboundMessage } from "../../../../multimodal/ingest";
import type { MoziConfig } from "../../../../config";
import type { ChannelPlugin } from "../../../adapters/channels/plugin";
import type { InboundMessage } from "../../../adapters/channels/types";
import type { AgentManager, ModelRegistry, SessionStore } from "../../..";
import type { OrchestratorDeps } from "../contract";
import type { InteractionPhase, PhasePayload } from "./interaction-lifecycle";
import {
  emitPhaseSafely as emitPhaseSafelyService,
  startTypingIndicator as startTypingIndicatorService,
  stopTypingIndicator as stopTypingIndicatorService,
} from "./interaction-lifecycle";
import { buildPromptText, buildRawTextWithTranscription } from "./prompt-text";
import { resolveSessionMessages, resolveSessionMetadata, resolveSessionTimestamps } from "./orchestrator-session";
import { checkInputCapability as checkInputCapabilityService } from "./capability";
import { finalizeStreamingReply, buildNegotiatedOutbound, sendNegotiatedReply } from "./reply-dispatcher";
import {
  resolveLastAssistantReplyText,
  shouldSuppressHeartbeatReply,
  shouldSuppressSilentReply,
  type AssistantMessageShape,
} from "./reply-finalizer";
import { resolveReplyRenderOptionsFromConfig } from "../render/reasoning";
import { StreamingBuffer } from "./streaming";
import { parseInlineOverrides } from "../../commands/reasoning";
import { toError as toErrorService, isAbortError as isAbortErrorService } from "./error-utils";
import { createErrorReplyText as createErrorReplyTextService } from "./error-reply";
import type { InboundMediaPreprocessor } from "../../../media-understanding/preprocess";

interface BuilderLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export function buildOrchestratorDeps(params: {
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
  latestPromptMessages: Map<string, AssistantMessageShape[]>;
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
}): OrchestratorDeps {
  const {
    channel,
    config,
    logger,
    sessions,
    agentManager,
    modelRegistry,
    mediaPreprocessor,
    lastRoutes,
    latestPromptMessages,
    resolveSessionContext,
    parseCommand,
    normalizeImplicitControlCommand,
    createCommandHandlerMap,
    runPromptWithFallback,
    maybePreFlushBeforePrompt,
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
    send: (peerId: string, message: Parameters<ChannelPlugin["send"]>[1]) => channel.send(peerId, message),
    editMessage: async (messageId: string, peerId: string, text: string) => {
      if (channel.editMessage) {
        await channel.editMessage(messageId, peerId, text);
      }
    },
  };

  return {
    config,
    logger,
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
    getChannel: () => ({
      id: channel.id,
      editMessage: (messageId, peerId, text) => channel.editMessage?.(messageId, peerId, text) ?? Promise.resolve(),
      send: (peerId, message) => channel.send(peerId, message),
    }),
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
    getSessionMessages: (sessionKey) =>
      resolveSessionMessages({ sessionKey, sessions, agentManager, latestPromptMessages }),
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
              const routed = await agentManager.ensureSessionModelForInput({ sessionKey, agentId, input });
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
      await agentManager.ensureChannelContext({ sessionKey, agentId, message: message as InboundMessage });
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
    createStreamingBuffer: ({ peerId, onError }) => new StreamingBuffer(streamingChannel, peerId, onError),
    runPromptWithFallback: async ({ sessionKey, agentId, text, onStream, onFallback }) => {
      await runPromptWithFallback({ sessionKey, agentId, text, onStream, onFallback });
      const current = await agentManager.getAgent(sessionKey, agentId);
      latestPromptMessages.set(sessionKey, current.agent.messages as AssistantMessageShape[]);
    },
    maybePreFlushBeforePrompt: async ({ sessionKey, agentId }) => {
      await maybePreFlushBeforePrompt({ sessionKey, agentId });
    },
    resolveReplyRenderOptions: (agentId) =>
      resolveReplyRenderOptionsFromConfig(agentId, (config.agents || {}) as Record<string, unknown>),
    resolveLastAssistantReplyText: ({ messages, renderOptions }) =>
      resolveLastAssistantReplyText({ messages, renderOptions }),
    shouldSuppressSilentReply: (text) => shouldSuppressSilentReply(text),
    shouldSuppressHeartbeatReply: (raw, text) =>
      shouldSuppressHeartbeatReply(raw as { source?: string } | undefined, text),
    finalizeStreamingReply: async ({ buffer, replyText }) => finalizeStreamingReply({ buffer, replyText }),
    buildNegotiatedOutbound: ({ channelId, replyText, inboundPlan }) =>
      buildNegotiatedOutbound({ channelId, replyText, inboundPlan }),
    sendNegotiatedReply: async ({ peerId, outbound }) =>
      sendNegotiatedReply({ channel, peerId, outbound }),
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
