import type { DeliveryContext } from "../../routing/types";
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
  const { state, payload } = ctx;
  const toError = (err: unknown) => deps.toError(err);
  const emitPhase = (params: Parameters<typeof deps.emitPhaseSafely>[0]) =>
    deps.emitPhaseSafely(params);
  const emitStatus = (params: Parameters<typeof deps.emitStatusSafely>[0]) =>
    deps.emitStatusSafely(params);
  const isAbortError = (err: Error) => deps.isAbortError(err);
  const isAgentBusyError = (err: Error) => deps.isAgentBusyError(err);
  const createErrorReplyText = (err: Error) => deps.createErrorReplyText(err);
  const getChannel = (channelPayload: unknown) => deps.getChannel(channelPayload);
  const dispatchReply = (params: {
    delivery: DeliveryContext;
    replyText?: string;
    inboundPlan: null;
  }) => deps.dispatchReply(params);
  const { logger } = deps;

  // Artifact Extraction
  const sessionKey = typeof state.sessionKey === "string" ? state.sessionKey : undefined;
  const agentId = typeof state.agentId === "string" ? state.agentId : undefined;
  const peerId = typeof state.peerId === "string" ? state.peerId : undefined;
  const channel = getChannel(payload);
  const routeFromState =
    state.route &&
    typeof state.route === "object" &&
    typeof (state.route as { channelId?: unknown }).channelId === "string" &&
    typeof (state.route as { peerId?: unknown }).peerId === "string" &&
    typeof (state.route as { peerType?: unknown }).peerType === "string"
      ? (state.route as DeliveryContext["route"])
      : peerId
        ? {
            channelId: channel.id,
            peerId,
            peerType: "dm" as const,
          }
        : undefined;
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
    await emitStatus({
      status: "error",
      messageId: ctx.messageId,
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
      if (isAgentBusyError(err)) {
        logger.info(
          {
            traceId: ctx.traceId,
            sessionKey,
            agentId,
            peerId,
            error: err.message,
          },
          "Suppressed busy error reply while message is queued/injected",
        );
        if (streamingBuffer) {
          try {
            await streamingBuffer.finalize();
          } catch {}
        }
        return "handled";
      }

      const errorText = createErrorReplyText(err);

      if (streamingBuffer) {
        try {
          await streamingBuffer.finalize(errorText);
          return "handled";
        } catch {}
      }

      if (!routeFromState) {
        return "handled";
      }

      try {
        await dispatchReply({
          delivery: {
            route: routeFromState,
            traceId: ctx.traceId,
            sessionKey,
            agentId,
            source: "turn",
          },
          replyText: errorText,
          inboundPlan: null,
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
