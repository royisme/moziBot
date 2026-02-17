import { createHash } from "node:crypto";
import type { DeliveryPlan } from "../../../../multimodal/capabilities";
import type { ExecutionFlow } from "../contract";
import type { FallbackInfo } from "../services/prompt-runner";
import { renderAssistantReply } from "../../reply-utils";
import { resolveCurrentReasoningLevel } from "../services/reasoning-level";
import { StreamingBuffer } from "../services/streaming";
import { resolveTerminalReplyDecision } from "../services/terminal-text-resolver";

function hashPreview(text: string | undefined): string {
  if (!text) {
    return "none";
  }
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function sanitizeIdentityDrift(
  text: string | undefined,
  isIdentityQuery: boolean,
): string | undefined {
  if (!text || !isIdentityQuery) {
    return text;
  }

  const normalized = text.trim();
  const genericPiPattern =
    /(^|\n|\s)(i\s*am\s*pi|i\s*'m\s*pi|我是\s*pi|我是\s*Pi)(\b|\s|[，。,.!！?？])/i;
  if (!genericPiPattern.test(normalized)) {
    return text;
  }

  return "我会按照你在 IDENTITY.md / SOUL.md 中定义的身份工作。你也可以使用 /whoami 查看当前身份信息。";
}

class StreamingReasoningFilter {
  private carry = "";
  private inThinking = false;

  append(delta: string): string {
    if (!delta) {
      return "";
    }

    const text = this.carry + delta;
    this.carry = "";
    let output = "";
    let cursor = 0;

    while (cursor < text.length) {
      const open = text.indexOf("<", cursor);
      if (open < 0) {
        if (!this.inThinking) {
          output += text.slice(cursor);
        }
        break;
      }

      if (!this.inThinking) {
        output += text.slice(cursor, open);
      }

      const close = text.indexOf(">", open + 1);
      if (close < 0) {
        this.carry = text.slice(open);
        break;
      }

      const rawTag = text.slice(open + 1, close).trim();
      const isClose = rawTag.startsWith("/");
      const core = isClose ? rawTag.slice(1).trim() : rawTag;
      const name = core.split(/\s+/)[0]?.toLowerCase() ?? "";
      const isThinkingTag =
        name === "think" || name === "thinking" || name === "thought" || name === "antthinking";

      if (!isThinkingTag && !this.inThinking) {
        output += text.slice(open, close + 1);
      } else if (isThinkingTag) {
        this.inThinking = !isClose;
      }

      cursor = close + 1;
    }

    return output;
  }
}

export const runExecutionFlow: ExecutionFlow = async (ctx, deps, bundle) => {
  const { state, payload } = ctx;
  const ensureChannelContext = (params: {
    sessionKey: string;
    agentId: string;
    message: unknown;
  }) => deps.ensureChannelContext(params);
  const resolveReasoningLevel = (params: {
    sessionMetadata: { reasoningLevel?: "off" | "on" | "stream" } | undefined;
    agentsConfig: Record<string, unknown>;
    agentId: string;
  }) => resolveCurrentReasoningLevel(params);

  const startTyping = (params: { sessionKey: string; agentId: string; peerId: string }) =>
    deps.startTypingIndicator(params);
  const emitPhase = (params: Parameters<typeof deps.emitPhaseSafely>[0]) =>
    deps.emitPhaseSafely(params);
  const getChannel = (p: unknown) => deps.getChannel(p);
  const createStreamingBuffer = (params: {
    peerId: string;
    onError: (err: Error) => void;
    traceId?: string;
  }) => deps.createStreamingBuffer(params);
  const runPrompt = (params: {
    sessionKey: string;
    agentId: string;
    text: string;
    traceId?: string;
    onStream?: Parameters<typeof deps.runPromptWithFallback>[0]["onStream"];
    onFallback?: (info: FallbackInfo) => Promise<void>;
  }) => deps.runPromptWithFallback(params);
  const isSilent = (text: string | undefined) => deps.shouldSuppressSilentReply(text);
  const isHeartbeatOk = (raw: unknown, text: string) =>
    deps.shouldSuppressHeartbeatReply(raw, text);
  const dispatchReply = (params: {
    peerId: string;
    channelId: string;
    replyText?: string;
    inboundPlan: DeliveryPlan | null;
    traceId?: string;
  }) => deps.dispatchReply(params);
  const { logger } = deps;

  // 1. Artifact Extraction with narrow guards
  const promptText = typeof bundle.config.promptText === "string" ? bundle.config.promptText : "";
  const ingestPlanArtifact = bundle.config.ingestPlan as DeliveryPlan | null;
  const sessionKey = typeof state.sessionKey === "string" ? state.sessionKey : undefined;
  const agentId = typeof state.agentId === "string" ? state.agentId : undefined;
  const peerId = typeof state.peerId === "string" ? state.peerId : undefined;

  if (!sessionKey || !agentId || !peerId) {
    return "abort";
  }

  // 2. Prelude: Context & Indicators
  await ensureChannelContext({ sessionKey, agentId, message: payload });

  state.stopTyping = await startTyping({ sessionKey, agentId, peerId });
  await emitPhase({
    phase: "thinking",
    payload: { sessionKey, agentId, messageId: ctx.messageId },
  });

  const channel = getChannel(payload);
  const supportsStreaming = typeof channel.editMessage === "function";
  const sessionMetadata = deps.getSessionMetadata(sessionKey) as
    | { reasoningLevel?: "off" | "on" | "stream" }
    | undefined;
  const reasoningLevel = resolveReasoningLevel({
    sessionMetadata,
    agentsConfig: deps.getConfigAgents(),
    agentId,
  });
  const shouldShowThinking = channel.id === "localDesktop" && reasoningLevel === "stream";
  const hasIdentityIntent =
    /(^|\s)(who\s+are\s+you|what\s+is\s+your\s+name|你是谁|你是誰|你叫什么|你叫什麼|自我介绍|自我介紹)($|\s|\?|？)/i.test(
      promptText,
    );
  const hasWorkIntent =
    /(目录|home|workspace|文件|代码|读取|列出|看看|分析|修复|实现|run|list|read|file|directory|code)/i.test(
      promptText,
    );
  const isIdentityQuery = hasIdentityIntent && !hasWorkIntent;
  const streamingReasoningFilter = shouldShowThinking ? null : new StreamingReasoningFilter();

  let streamingBuffer: StreamingBuffer | undefined;
  let streamTerminalText: string | undefined;
  let streamedDeltaText = "";

  const effectivePromptText = isIdentityQuery
    ? `${promptText}\n\n[Identity enforcement]\nIf the user asks who you are, answer strictly according to IDENTITY.md/SOUL.md/USER.md and their language constraints. Do not claim to be a generic pi assistant unless explicitly configured.`
    : promptText;

  // 3. Prompt Execution
  if (supportsStreaming) {
    streamingBuffer = createStreamingBuffer({
      peerId,
      onError: (err: Error) =>
        logger.warn({ traceId: ctx.traceId, err, sessionKey, agentId }, "Streaming buffer error"),
      traceId: ctx.traceId,
    });
    state.streamingBuffer = streamingBuffer;

    await runPrompt({
      sessionKey,
      agentId,
      text: effectivePromptText,
      traceId: ctx.traceId,
      onFallback: async (info: FallbackInfo) => {
        await dispatchReply({
          peerId,
          channelId: channel.id,
          replyText: `⚠️ Primary model failed this turn; using fallback model ${info.toModel} (from ${info.fromModel}). You can /switch if you want to keep using it.`,
          inboundPlan: null,
          traceId: ctx.traceId,
        });
      },
      onStream: async (event) => {
        if (event.type === "text_delta" && event.delta) {
          streamedDeltaText += event.delta;
          const visibleDelta =
            shouldShowThinking || !streamingReasoningFilter
              ? event.delta
              : streamingReasoningFilter.append(event.delta);
          if (visibleDelta) {
            streamingBuffer?.append(visibleDelta);
          }
        } else if (event.type === "agent_end") {
          if (event.fullText) {
            streamTerminalText = event.fullText;
          }
        } else if (event.type === "tool_start") {
          void emitPhase({
            phase: "executing",
            payload: {
              sessionKey,
              agentId,
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              messageId: ctx.messageId,
            },
          });
        } else if (event.type === "tool_end") {
          void emitPhase({
            phase: "thinking",
            payload: { sessionKey, agentId, messageId: ctx.messageId },
          });
        }
      },
    });
  } else {
    await runPrompt({
      sessionKey,
      agentId,
      text: effectivePromptText,
      traceId: ctx.traceId,
      onFallback: async (info: FallbackInfo) => {
        await dispatchReply({
          peerId,
          channelId: channel.id,
          replyText: `⚠️ Primary model failed this turn; using fallback model ${info.toModel} (from ${info.fromModel}).`,
          inboundPlan: null,
          traceId: ctx.traceId,
        });
      },
      onStream: async (event) => {
        if (event.type === "text_delta" && event.delta) {
          streamedDeltaText += event.delta;
          if (!shouldShowThinking && streamingReasoningFilter) {
            void streamingReasoningFilter.append(event.delta);
          }
        }
        if (event.type === "agent_end" && event.fullText) {
          streamTerminalText = event.fullText;
        }
      },
    });
  }

  // 4. Finalization & Suppression
  const finalReplyText = streamTerminalText;

  if (isSilent(finalReplyText)) {
    logger.info(
      { traceId: ctx.traceId, sessionKey, agentId },
      "Assistant replied with silent token. Suppression active.",
    );
    if (streamingBuffer) {
      state.outboundId = await streamingBuffer.finalize();
    }
    return "handled";
  }

  if (finalReplyText !== undefined && isHeartbeatOk(payload, finalReplyText)) {
    logger.info(
      { traceId: ctx.traceId, sessionKey, agentId },
      "Heartbeat acknowledged. Suppressing redundant OK reply.",
    );
    if (streamingBuffer) {
      state.outboundId = await streamingBuffer.finalize();
    }
    return "handled";
  }

  // 5. Outbound Dispatch
  await emitPhase({
    phase: "speaking",
    payload: { sessionKey, agentId, messageId: ctx.messageId },
  });

  let outboundId: string | null = null;
  let deliveryMode: "streaming_finalize" | "streaming_finalize_then_dispatch" | "direct_dispatch" =
    "direct_dispatch";
  const terminalDecision = resolveTerminalReplyDecision({
    finalReplyText,
    streamedReplyText: streamedDeltaText,
  });
  const terminalReplyTextRaw = terminalDecision.text;
  const renderedTerminalText = terminalReplyTextRaw
    ? renderAssistantReply(terminalReplyTextRaw, { showThinking: shouldShowThinking })
    : undefined;
  const terminalReplyText = sanitizeIdentityDrift(renderedTerminalText, isIdentityQuery);

  logger.info(
    {
      traceId: ctx.traceId,
      sessionKey,
      agentId,
      finalChars: terminalDecision.finalChars,
      streamedChars: terminalDecision.streamedChars,
      terminalChars: terminalReplyText?.length ?? 0,
      terminalHash: hashPreview(terminalReplyText),
      terminalSource: terminalDecision.source,
      supportsStreaming,
    },
    "Terminal reply decision",
  );

  if (streamingBuffer) {
    deliveryMode = "streaming_finalize";
    outboundId = await streamingBuffer.finalize(terminalReplyText);
    if (!outboundId) {
      deliveryMode = "streaming_finalize_then_dispatch";
      outboundId = await dispatchReply({
        peerId,
        channelId: channel.id,
        replyText: terminalReplyText,
        inboundPlan: ingestPlanArtifact,
        traceId: ctx.traceId,
      });
    }
  } else {
    deliveryMode = "direct_dispatch";
    outboundId = await dispatchReply({
      peerId,
      channelId: channel.id,
      replyText: terminalReplyText,
      inboundPlan: ingestPlanArtifact,
      traceId: ctx.traceId,
    });
  }

  logger.info(
    {
      traceId: ctx.traceId,
      sessionKey,
      agentId,
      outboundId,
      deliveryMode,
      terminalChars: terminalReplyText?.length ?? 0,
      terminalHash: hashPreview(terminalReplyText),
      terminalSource: terminalDecision.source,
    },
    "Terminal reply delivered",
  );

  state.outboundId = outboundId;
  return "continue";
};
