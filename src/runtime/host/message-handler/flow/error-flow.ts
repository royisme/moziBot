import type { ErrorFlow } from "../contract";

/**
 * Error Flow Implementation
 *
 * Orchestrates the centralized error handling path:
 * - Error normalization and logging
 * - Interaction phase updates
 * - Abort error short-circuiting
 * - User-facing error message generation and delivery
 */
export const runErrorFlow: ErrorFlow = async (ctx, deps, rawError) => {
  const { state } = ctx;
  const toError = (err: unknown) => deps.toError(err);
  const emitPhase = (params: Parameters<typeof deps.emitPhaseSafely>[0]) =>
    deps.emitPhaseSafely(params);
  const isAbortError = (err: Error) => deps.isAbortError(err);
  const createErrorReplyText = (err: Error) => deps.createErrorReplyText(err);
  const getChannel = (payload: unknown) => deps.getChannel(payload);
  const dispatchReply = (params: {
    peerId: string;
    channelId: string;
    replyText?: string;
    inboundPlan: null;
    traceId?: string;
  }) => deps.dispatchReply(params);
  const { logger } = deps;

  // Artifact Extraction
  const sessionKey = typeof state.sessionKey === "string" ? state.sessionKey : undefined;
  const agentId = typeof state.agentId === "string" ? state.agentId : undefined;
  const peerId = typeof state.peerId === "string" ? state.peerId : undefined;
  const channelId = getChannel(ctx.payload).id;
  const streamingBuffer =
    state.streamingBuffer &&
    typeof state.streamingBuffer === "object" &&
    typeof (state.streamingBuffer as { finalize?: unknown }).finalize === "function"
      ? (state.streamingBuffer as { finalize: (text?: string) => Promise<string | null> })
      : undefined;

  try {
    // 1. Normalization
    const err = toError(rawError);

    // 2. Interaction Phase Update
    await emitPhase({
      phase: "error",
      payload: { sessionKey, agentId, messageId: ctx.messageId },
    });

    // 3. Abort Short-Circuit
    if (isAbortError(err)) {
      logger.warn(
        { traceId: ctx.traceId, sessionKey, agentId, error: err.message },
        "Message handling aborted",
      );
      if (streamingBuffer) {
        try {
          await streamingBuffer.finalize();
        } catch {}
      }
      return "handled";
    }

    // 4. User-facing Error Reply
    if (peerId) {
      const errorText = createErrorReplyText(err);

      if (streamingBuffer) {
        try {
          await streamingBuffer.finalize(errorText);
          return "handled";
        } catch {}
      }

      try {
        await dispatchReply({
          peerId,
          channelId,
          replyText: errorText,
          inboundPlan: null,
          traceId: ctx.traceId,
        });
      } catch (deliveryError) {
        // Double-fault protection: log failure if error reply cannot be delivered
        logger.warn(
          {
            traceId: ctx.traceId,
            sessionKey,
            agentId,
            peerId,
            originalError: err.message,
            deliveryError: toError(deliveryError).message,
          },
          "Failed to deliver error reply to user",
        );
      }
    }

    return "handled";
  } catch {
    // Final safety boundary for the error flow itself
    return "abort";
  }
};
