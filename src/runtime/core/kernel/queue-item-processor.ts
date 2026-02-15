import { randomUUID } from "node:crypto";
import type { ChannelPlugin } from "../../adapters/channels/plugin";
import type { InboundMessage } from "../../adapters/channels/types";
import type { MessageHandler } from "../../host/message-handler";
import type { SessionManager } from "../../host/sessions/manager";
import type { RuntimeErrorPolicy } from "../contracts";
import { logger } from "../../../logger";
import { runtimeQueue, type RuntimeQueueItem } from "../../../storage/db";
import { SessionStatus } from "../constants";
import { continuationRegistry } from "../continuation";

export async function processQueueItem(params: {
  queueItem: RuntimeQueueItem;
  messageHandler: MessageHandler;
  sessionManager: SessionManager;
  errorPolicy: RuntimeErrorPolicy;
  parseInbound: (json: string) => InboundMessage;
  buildRuntimeChannel: (params: {
    queueItem: RuntimeQueueItem;
    envelopeId: string;
  }) => ChannelPlugin;
  schedulePump: () => void;
}): Promise<void> {
  continuationRegistry.resumeSession(params.queueItem.session_key);
  const inbound = params.parseInbound(params.queueItem.inbound_json);
  const channel = params.buildRuntimeChannel({
    queueItem: params.queueItem,
    envelopeId: params.queueItem.id,
  });
  const startedAt = Date.now();

  await params.sessionManager.setStatus(params.queueItem.session_key, SessionStatus.RUNNING);
  logger.info(
    {
      queueItemId: params.queueItem.id,
      sessionKey: params.queueItem.session_key,
      messageId: inbound.id,
      channel: inbound.channel,
      peerId: inbound.peerId,
      attempts: params.queueItem.attempts,
    },
    "Queue item processing started",
  );
  try {
    await params.messageHandler.handle(inbound, channel);
    const completed = runtimeQueue.markCompletedIfRunning(params.queueItem.id);
    if (!completed) {
      const current = runtimeQueue.getById(params.queueItem.id);
      if (current?.status === SessionStatus.INTERRUPTED) {
        await params.sessionManager.setStatus(
          params.queueItem.session_key,
          SessionStatus.INTERRUPTED,
        );
        logger.warn(
          {
            queueItemId: params.queueItem.id,
            sessionKey: params.queueItem.session_key,
            messageId: inbound.id,
            durationMs: Date.now() - startedAt,
          },
          "Queue item ended after interruption",
        );
        return;
      }
      logger.warn(
        {
          queueItemId: params.queueItem.id,
          sessionKey: params.queueItem.session_key,
          status: current?.status,
        },
        "Skipped completion because queue item is no longer running",
      );
      return;
    }
    await params.sessionManager.setStatus(params.queueItem.session_key, SessionStatus.COMPLETED);
    logger.info(
      {
        queueItemId: params.queueItem.id,
        sessionKey: params.queueItem.session_key,
        messageId: inbound.id,
        durationMs: Date.now() - startedAt,
      },
      "Queue item completed",
    );

    await processPendingContinuations({
      sessionKey: params.queueItem.session_key,
      channelId: params.queueItem.channel_id,
      peerId: params.queueItem.peer_id,
      peerType: params.queueItem.peer_type,
      originalInbound: inbound,
      sessionManager: params.sessionManager,
      schedulePump: params.schedulePump,
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const current = runtimeQueue.getById(params.queueItem.id);
    if (current?.status === SessionStatus.INTERRUPTED) {
      await params.sessionManager.setStatus(
        params.queueItem.session_key,
        SessionStatus.INTERRUPTED,
      );
      logger.warn(
        {
          queueItemId: params.queueItem.id,
          sessionKey: params.queueItem.session_key,
          messageId: inbound.id,
          error: err.message,
          durationMs: Date.now() - startedAt,
        },
        "Queue item interrupted while processing",
      );
      return;
    }
    const nextAttempt = params.queueItem.attempts + 1;
    const decision = params.errorPolicy.decide(err, nextAttempt);
    if (decision.retry) {
      const next = new Date(Date.now() + Math.max(0, decision.delayMs)).toISOString();
      const retried = runtimeQueue.markRetryingIfRunning(
        params.queueItem.id,
        `${decision.reason}: ${err.message}`,
        next,
      );
      if (!retried) {
        const latest = runtimeQueue.getById(params.queueItem.id);
        if (latest?.status === SessionStatus.INTERRUPTED) {
          await params.sessionManager.setStatus(
            params.queueItem.session_key,
            SessionStatus.INTERRUPTED,
          );
          return;
        }
        logger.warn(
          {
            queueItemId: params.queueItem.id,
            sessionKey: params.queueItem.session_key,
            status: latest?.status,
          },
          "Skipped retry because queue item is no longer running",
        );
        return;
      }
      await params.sessionManager.setStatus(params.queueItem.session_key, SessionStatus.RETRYING);
      logger.warn(
        {
          queueItemId: params.queueItem.id,
          sessionKey: params.queueItem.session_key,
          messageId: inbound.id,
          attempts: params.queueItem.attempts,
          nextAttempt,
          retryAt: next,
          reason: decision.reason,
          error: err.message,
          durationMs: Date.now() - startedAt,
        },
        "Queue item scheduled for retry",
      );
      return;
    }
    const failed = runtimeQueue.markFailedIfRunning(
      params.queueItem.id,
      `${decision.reason}: ${err.message}`,
    );
    if (!failed) {
      const latest = runtimeQueue.getById(params.queueItem.id);
      if (latest?.status === SessionStatus.INTERRUPTED) {
        await params.sessionManager.setStatus(
          params.queueItem.session_key,
          SessionStatus.INTERRUPTED,
        );
        return;
      }
      logger.warn(
        {
          queueItemId: params.queueItem.id,
          sessionKey: params.queueItem.session_key,
          status: latest?.status,
        },
        "Skipped failure mark because queue item is no longer running",
      );
      return;
    }
    await params.sessionManager.setStatus(params.queueItem.session_key, SessionStatus.FAILED);
    logger.error(
      {
        queueItemId: params.queueItem.id,
        sessionKey: params.queueItem.session_key,
        messageId: inbound.id,
        attempts: params.queueItem.attempts,
        reason: decision.reason,
        error: err.message,
        durationMs: Date.now() - startedAt,
      },
      "Queue item failed",
    );
  }
}

async function processPendingContinuations(params: {
  sessionKey: string;
  channelId: string;
  peerId: string;
  peerType: string;
  originalInbound: InboundMessage;
  sessionManager: SessionManager;
  schedulePump: () => void;
}): Promise<void> {
  const continuations = continuationRegistry.consume(params.sessionKey);
  if (continuations.length === 0) {
    return;
  }

  for (const continuation of continuations) {
    await enqueueContinuation({
      ...params,
      continuation,
    });
  }
}

async function enqueueContinuation(params: {
  sessionKey: string;
  channelId: string;
  peerId: string;
  peerType: string;
  originalInbound: InboundMessage;
  continuation: {
    prompt: string;
    reason?: string;
    context?: unknown;
    delayMs?: number;
  };
  sessionManager: SessionManager;
  schedulePump: () => void;
}): Promise<void> {
  const now = new Date();
  const delayMs = params.continuation.delayMs ?? 0;
  const availableAt = new Date(now.getTime() + delayMs);
  const queueItemId = randomUUID();
  const dedupKey = `continuation:${params.sessionKey}:${queueItemId}`;

  const continuationInbound: InboundMessage = {
    id: queueItemId,
    channel: params.channelId,
    peerId: params.peerId,
    peerType: params.originalInbound.peerType,
    senderId: params.originalInbound.senderId,
    text: params.continuation.prompt,
    timestamp: now,
    raw: {
      source: "continuation",
      reason: params.continuation.reason,
      context: params.continuation.context,
      parentMessageId: params.originalInbound.id,
    },
  };

  const inserted = runtimeQueue.enqueue({
    id: queueItemId,
    dedupKey,
    sessionKey: params.sessionKey,
    channelId: params.channelId,
    peerId: params.peerId,
    peerType: params.peerType,
    inboundJson: JSON.stringify(continuationInbound),
    enqueuedAt: now.toISOString(),
    availableAt: availableAt.toISOString(),
  });

  if (inserted.inserted) {
    await params.sessionManager.setStatus(params.sessionKey, SessionStatus.QUEUED);
    params.schedulePump();
    logger.info(
      {
        queueItemId,
        sessionKey: params.sessionKey,
        reason: params.continuation.reason,
        delayMs,
        promptChars: params.continuation.prompt.length,
      },
      "Continuation enqueued",
    );
  }
}
