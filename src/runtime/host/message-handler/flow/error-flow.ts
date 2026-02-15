import type { ErrorFlow } from "../contract";
import type { InteractionPhase, PhasePayload } from "../services/interaction-lifecycle";

/**
 * Runtime-guarded helper to ensure a function exists on an unknown object.
 */
function requireFn<T>(deps: unknown, key: string): T {
  const obj = deps as Record<string, unknown>;
  const fn = obj[key];
  if (typeof fn !== "function") {
    throw new Error(`Missing required dependency function: ${key}`);
  }
  return fn as unknown as T;
}

function requireObj<T extends object>(deps: unknown, key: string): T {
  const obj = deps as Record<string, unknown>;
  const target = obj[key];
  if (!target || typeof target !== "object") {
    throw new Error(`Missing required dependency object: ${key}`);
  }
  return target as T;
}

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

  // Artifact Extraction
  const sessionKey = typeof state.sessionKey === "string" ? state.sessionKey : undefined;
  const agentId = typeof state.agentId === "string" ? state.agentId : undefined;
  const peerId = typeof state.peerId === "string" ? state.peerId : undefined;

  // Dependency Extraction
  const toError = requireFn<(e: unknown) => Error>(deps, "toError");
  const emitPhase = requireFn<
    (p: { phase: InteractionPhase; payload: PhasePayload }) => Promise<void>
  >(deps, "emitPhaseSafely");
  const isAbortError = requireFn<(e: Error) => boolean>(deps, "isAbortError");
  const createErrorReplyText = requireFn<(e: Error) => string>(deps, "createErrorReplyText");
  const sendReply = requireFn<
    (p: { peerId: string; outbound: { text: string } }) => Promise<string>
  >(deps, "sendNegotiatedReply");
  const logger = requireObj<{ warn: (o: Record<string, unknown>, m: string) => void }>(
    deps,
    "logger",
  );

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
      return "handled";
    }

    // 4. User-facing Error Reply
    if (peerId) {
      const errorText = createErrorReplyText(err);

      try {
        const outbound = { text: errorText, traceId: ctx.traceId };
        await sendReply({
          peerId,
          outbound,
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
