import type { ExecutionFlow } from '../contract';
import type { InteractionPhase, PhasePayload } from '../services/interaction-lifecycle';
import { type StreamingCallback, StreamingBuffer } from '../services/streaming';
import type { FallbackInfo } from '../services/prompt-runner';
import type { ReplyRenderOptions } from '../render/reasoning';
import type { AssistantMessageShape } from '../services/reply-finalizer';
import type { DeliveryPlan } from '../../../../multimodal/capabilities';
import type { OutboundMessage } from '../../../adapters/channels/types';

/**
 * Runtime-guarded helper to ensure a function exists on an unknown object.
 */
function requireFn<T>(deps: unknown, key: string): T {
  const obj = deps as Record<string, unknown>;
  const fn = obj[key];
  if (typeof fn !== 'function') {
    throw new Error(`Missing required dependency function: ${key}`);
  }
  return fn as unknown as T;
}

function requireObj<T extends object>(deps: unknown, key: string): T {
  const obj = deps as Record<string, unknown>;
  const target = obj[key];
  if (!target || typeof target !== 'object') {
    throw new Error(`Missing required dependency object: ${key}`);
  }
  return target as T;
}

/**
 * Execution Flow Implementation
 * 
 * Orchestrates the execution of a prepared prompt turn:
 * - UI indicators and phase tracking
 * - Prompt execution with fallbacks
 * - Streaming path management
 * - Reply finalization and suppression
 * - Outbound dispatch
 */
export const runExecutionFlow: ExecutionFlow = async (ctx, deps, bundle) => {
  const { state, payload } = ctx;

  // 1. Artifact Extraction with narrow guards
  const promptText = typeof bundle.config.promptText === 'string' ? bundle.config.promptText : '';
  const ingestPlanArtifact = bundle.config.ingestPlan as DeliveryPlan | null;
  const sessionKey = typeof state.sessionKey === 'string' ? state.sessionKey : undefined;
  const agentId = typeof state.agentId === 'string' ? state.agentId : undefined;
  const peerId = typeof state.peerId === 'string' ? state.peerId : undefined;

  if (!sessionKey || !agentId || !peerId) {
    return 'abort';
  }

  // Dependency Extraction
  const ensureChannelContext = requireFn<(p: { sessionKey: string; agentId: string; message: unknown }) => Promise<void>>(deps, 'ensureChannelContext');
  const startTyping = requireFn<(p: { sessionKey: string; agentId: string; peerId: string }) => Promise<(() => Promise<void> | void) | undefined>>(deps, 'startTypingIndicator');
  const emitPhase = requireFn<(p: { phase: InteractionPhase; payload: PhasePayload }) => Promise<void>>(deps, 'emitPhaseSafely');
  const getChannel = requireFn<(p: unknown) => { editMessage?: unknown; id: string }>(deps, 'getChannel');
  const createStreamingBuffer = requireFn<(p: { peerId: string; onError: (err: Error) => void }) => StreamingBuffer>(deps, 'createStreamingBuffer');
  const runPrompt = requireFn<(p: { 
    sessionKey: string; 
    agentId: string; 
    text: string; 
    onStream?: StreamingCallback;
    onFallback?: (info: FallbackInfo) => Promise<void>;
  }) => Promise<void>>(deps, 'runPromptWithFallback');
  const getMessages = requireFn<(sk: string) => AssistantMessageShape[]>(deps, 'getSessionMessages');
  const getRenderOptions = requireFn<(ai: string) => ReplyRenderOptions>(deps, 'resolveReplyRenderOptions');
  const resolveReplyText = requireFn<(p: { messages: AssistantMessageShape[]; renderOptions: ReplyRenderOptions }) => string | undefined>(deps, 'resolveLastAssistantReplyText');
  const isSilent = requireFn<(t: string | undefined) => boolean>(deps, 'shouldSuppressSilentReply');
  const isHeartbeatOk = requireFn<(raw: unknown, t: string) => boolean>(deps, 'shouldSuppressHeartbeatReply');
  const finalizeStreaming = requireFn<(p: { buffer: StreamingBuffer; replyText?: string }) => Promise<string | null>>(deps, 'finalizeStreamingReply');
  const buildOutbound = requireFn<(p: { channelId: string; replyText?: string; inboundPlan: DeliveryPlan | null }) => OutboundMessage>(deps, 'buildNegotiatedOutbound');
  const sendReply = requireFn<(p: { peerId: string; outbound: OutboundMessage }) => Promise<string>>(deps, 'sendNegotiatedReply');
  const logger = requireObj<{ info: (o: Record<string, unknown>, m: string) => void; warn: (o: Record<string, unknown>, m: string) => void }>(deps, 'logger');

  // 2. Prelude: Context & Indicators
  await ensureChannelContext({ sessionKey, agentId, message: payload });
    
  state.stopTyping = await startTyping({ sessionKey, agentId, peerId });
  await emitPhase({ phase: 'thinking', payload: { sessionKey, agentId, messageId: ctx.messageId } });

  const channel = getChannel(payload);
  const supportsStreaming = typeof channel.editMessage === 'function';
  let streamingBuffer: StreamingBuffer | undefined;

  // 3. Prompt Execution
  if (supportsStreaming) {
      streamingBuffer = createStreamingBuffer({ 
        peerId, 
        onError: (err: Error) => logger.warn({ err, sessionKey, agentId }, 'Streaming buffer error') 
      });
      await streamingBuffer.initialize();

      await runPrompt({
        sessionKey,
        agentId,
        text: promptText,
        onFallback: async (info: FallbackInfo) => {
          const outbound = buildOutbound({ channelId: channel.id, replyText: `⚠️ Primary model failed this turn; using fallback model ${info.toModel} (from ${info.fromModel}). You can /switch if you want to keep using it.`, inboundPlan: null });
          await sendReply({ peerId, outbound });
        },
        onStream: (event) => {
          if (event.type === 'text_delta' && event.delta) {
            streamingBuffer?.append(event.delta);
          } else if (event.type === 'tool_start') {
            void emitPhase({ phase: 'executing', payload: { sessionKey, agentId, toolName: event.toolName, toolCallId: event.toolCallId, messageId: ctx.messageId } });
          } else if (event.type === 'tool_end') {
            void emitPhase({ phase: 'thinking', payload: { sessionKey, agentId, messageId: ctx.messageId } });
          }
        }
      });
  } else {
      await runPrompt({
        sessionKey,
        agentId,
        text: promptText,
        onFallback: async (info: FallbackInfo) => {
          const outbound = buildOutbound({ channelId: channel.id, replyText: `⚠️ Primary model failed this turn; using fallback model ${info.toModel} (from ${info.fromModel}).`, inboundPlan: null });
          await sendReply({ peerId, outbound });
        }
      });
  }

  // 4. Finalization & Suppression
  const messages = getMessages(sessionKey);
  const renderOptions = getRenderOptions(agentId);
  const replyText = resolveReplyText({ messages, renderOptions });
    
  if (isSilent(replyText)) {
    logger.info({ sessionKey, agentId }, 'Assistant replied with silent token. Suppression active.');
    return 'handled';
  }

  if (replyText !== undefined && isHeartbeatOk(payload, replyText)) {
    logger.info({ sessionKey, agentId }, 'Heartbeat acknowledged. Suppressing redundant OK reply.');
    return 'handled';
  }

  state.replyText = replyText;

  // 5. Outbound Dispatch
  await emitPhase({ phase: 'speaking', payload: { sessionKey, agentId, messageId: ctx.messageId } });

  let outboundId: string | null = null;
  if (streamingBuffer) {
    outboundId = await finalizeStreaming({ buffer: streamingBuffer, replyText });
  } else {
    const outbound = buildOutbound({ channelId: channel.id, replyText, inboundPlan: ingestPlanArtifact });
    outboundId = await sendReply({ peerId, outbound });
  }

  state.outboundId = outboundId;
  return 'continue';
};
