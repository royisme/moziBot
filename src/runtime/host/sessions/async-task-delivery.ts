import { logger } from "../../../logger";

/**
 * Direct Delivery Service for guaranteed user notification.
 *
 * This service provides a direct runtime delivery path for lifecycle events
 * that bypasses the LLM summarization flow. This ensures user-visible
 * delivery even when summarization returns NO_REPLY or fails.
 */

export interface DirectDeliveryDeps {
  getChannel: (sessionKey: string) => {
    send: (peerId: string, message: { text: string; threadId?: string; replyToId?: string }) => Promise<string>;
    getCapabilities: () => unknown;
  } | undefined;
  getPeerId: (sessionKey: string) => string | undefined;
  getRoute?: (sessionKey: string) => {
    threadId?: string;
    replyToId?: string;
  } | undefined;
}

let deliveryDeps: DirectDeliveryDeps | null = null;

export function injectDirectDeliveryDeps(deps: DirectDeliveryDeps): void {
  deliveryDeps = deps;
}

/**
 * Directly deliver a message to the user via the channel, bypassing LLM summarization.
 * Returns the messageId if successful, undefined otherwise.
 */
export async function deliverDirectMessage(params: {
  sessionKey: string;
  text: string;
}): Promise<string | undefined> {
  if (!deliveryDeps) {
    logger.warn("Direct delivery deps not injected, falling back to summarization path");
    return undefined;
  }

  const channel = deliveryDeps.getChannel(params.sessionKey);
  const peerId = deliveryDeps.getPeerId(params.sessionKey);
  const route = deliveryDeps.getRoute?.(params.sessionKey);

  if (!channel) {
    logger.warn({ sessionKey: params.sessionKey }, "Channel not found for direct delivery");
    return undefined;
  }

  if (!peerId) {
    logger.warn({ sessionKey: params.sessionKey }, "PeerId not found for direct delivery");
    return undefined;
  }

  try {
    const messageId = await channel.send(peerId, {
      text: params.text,
      threadId: route?.threadId,
      replyToId: route?.replyToId,
    });
    logger.info(
      { sessionKey: params.sessionKey, messageId },
      "Direct delivery succeeded for lifecycle event",
    );
    return messageId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, sessionKey: params.sessionKey }, "Direct delivery failed");
    return undefined;
  }
}

/**
 * Build a simple acknowledgment message for a lifecycle phase.
 * This is a deterministic, user-friendly message that doesn't require LLM generation.
 */
export function buildSimpleAckMessage(params: {
  taskLabel: string;
  phase: "accepted" | "started" | "streaming" | "completed" | "failed" | "timeout" | "aborted";
  duration?: string;
  error?: string;
}): string {
  const { taskLabel, phase, duration, error } = params;

  switch (phase) {
    case "accepted":
      return `Background task "${taskLabel}" has been accepted.`;
    case "started":
      return `Working on "${taskLabel}"...`;
    case "streaming":
      return `Task "${taskLabel}" is producing output.`;
    case "completed":
      return duration
        ? `Background task "${taskLabel}" completed in ${duration}.`
        : `Background task "${taskLabel}" completed.`;
    case "failed":
      return error
        ? `Background task "${taskLabel}" failed: ${error}`
        : `Background task "${taskLabel}" failed.`;
    case "timeout":
      return duration
        ? `Background task "${taskLabel}" timed out after ${duration}.`
        : `Background task "${taskLabel}" timed out.`;
    case "aborted":
      return error
        ? `Background task "${taskLabel}" was cancelled: ${error}`
        : `Background task "${taskLabel}" was cancelled.`;
    default:
      return `Background task "${taskLabel}" status: ${phase}`;
  }
}

function formatDuration(startMs?: number, endMs?: number): string {
  if (!startMs || !endMs) {
    return "";
  }
  const totalSec = Math.round((endMs - startMs) / 1000);
  if (totalSec < 60) {
    return `${totalSec}s`;
  }
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m${sec}s`;
}

/**
 * Deliver a guaranteed lifecycle notification to the user.
 * This first attempts direct delivery, then falls back to the summarization path.
 *
 * Returns: { delivered: boolean, messageId?: string, usedFallback: boolean }
 */
export async function deliverGuaranteedLifecycleNotification(params: {
  sessionKey: string;
  taskLabel: string;
  phase: "accepted" | "started" | "streaming" | "completed" | "failed" | "timeout" | "aborted";
  startedAt?: number;
  endedAt?: number;
  error?: string;
  // Callback to the summarization/announce flow (existing behavior)
  fallbackAnnounce: () => Promise<boolean>;
}): Promise<{ delivered: boolean; messageId?: string; usedFallback: boolean }> {
  const { sessionKey, taskLabel, phase, startedAt, endedAt, error, fallbackAnnounce } = params;

  // Build simple deterministic message for direct delivery
  const duration = formatDuration(startedAt, endedAt);
  const directMessage = buildSimpleAckMessage({
    taskLabel,
    phase,
    duration,
    error: error?.slice(0, 200),
  });

  // Try direct delivery first
  const messageId = await deliverDirectMessage({
    sessionKey,
    text: directMessage,
  });

  if (messageId) {
    return { delivered: true, messageId, usedFallback: false };
  }

  // Direct delivery failed, fall back to summarization
  logger.info(
    { sessionKey, taskLabel, phase },
    "Direct delivery failed, falling back to summarization",
  );

  const fallbackDelivered = await fallbackAnnounce();

  return {
    delivered: fallbackDelivered,
    messageId: undefined, // We don't get a messageId from fallback
    usedFallback: true,
  };
}
