import { randomUUID } from "node:crypto";
import { logger } from "../../../logger";
import { runtimeQueue, type RuntimeQueueItem } from "../../../storage/db";
import type { ChannelPlugin } from "../../adapters/channels/plugin";
import type { InboundMessage } from "../../adapters/channels/types";
import type { MessageHandler } from "../../host/message-handler";
import { startDetachedRun as startDetachedRunService } from "../../host/message-handler/services/run-dispatch";
import type { SessionManager } from "../../host/sessions/manager";
import { SessionStatus } from "../constants";
import { continuationRegistry } from "../continuation";
import type { RuntimeErrorPolicy } from "../contracts";

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
  releaseSession: () => void;
}): Promise<void> {
  let sessionReleased = false;
  const releaseSessionOnce = () => {
    if (sessionReleased) {
      return;
    }
    sessionReleased = true;
    params.releaseSession();
  };

  try {
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

    const onTerminal = async ({
      terminal,
      error,
      reason,
      errorCode,
    }: {
      terminal: "completed" | "failed" | "aborted";
      error?: Error;
      reason?: string;
      errorCode?: string;
    }) => {
      try {
        await handleDetachedTerminal({
          ...params,
          inbound,
          startedAt,
          terminal,
          error,
          reason,
          errorCode,
        });
      } catch (terminalError) {
        const err =
          terminalError instanceof Error ? terminalError : new Error(String(terminalError));
        logger.error(
          {
            queueItemId: params.queueItem.id,
            sessionKey: params.queueItem.session_key,
            messageId: inbound.id,
            terminal,
            reason,
            error: err.message,
          },
          "Queue item terminal handling failed",
        );

        const failed = runtimeQueue.markFailedIfRunning(
          params.queueItem.id,
          `terminal handling failed: ${err.message}`,
        );
        if (failed) {
          try {
            await params.sessionManager.setStatus(
              params.queueItem.session_key,
              SessionStatus.FAILED,
            );
          } catch (statusError) {
            const statusErr =
              statusError instanceof Error ? statusError : new Error(String(statusError));
            logger.error(
              {
                queueItemId: params.queueItem.id,
                sessionKey: params.queueItem.session_key,
                error: statusErr.message,
              },
              "Failed to update session status after terminal handling error",
            );
          }
        }
      } finally {
        releaseSessionOnce();
      }
    };

    const { runId } = await startDetachedRunService({
      starter: async (runParams) => {
        const handler = params.messageHandler as MessageHandler & {
          startDetachedRun?: (params: {
            message: InboundMessage;
            channel: ChannelPlugin;
            queueItemId?: string;
            onTerminal?: (params: {
              terminal: "completed" | "failed" | "aborted";
              error?: Error;
              reason?: string;
              errorCode?: string;
            }) => Promise<void> | void;
          }) => Promise<{ runId: string }>;
        };

        if (typeof handler.startDetachedRun === "function") {
          return await handler.startDetachedRun(runParams);
        }

        const legacyRunId = `legacy:${runParams.message.id}`;
        queueMicrotask(() => {
          void (async () => {
            try {
              await params.messageHandler.handle(runParams.message, runParams.channel);
              await onTerminal({ terminal: "completed" });
            } catch (error) {
              const err = error instanceof Error ? error : new Error(String(error));
              await onTerminal({
                terminal: "failed",
                error: err,
                reason: err.message,
              });
            }
          })();
        });
        return { runId: legacyRunId };
      },
      message: inbound,
      channel,
      queueItemId: params.queueItem.id,
      onTerminal,
    });

    logger.info(
      {
        queueItemId: params.queueItem.id,
        sessionKey: params.queueItem.session_key,
        messageId: inbound.id,
        runId,
      },
      "Queue item detached run accepted",
    );
    return;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const nextAttempt = params.queueItem.attempts + 1;
    const decision = params.errorPolicy.decide(err, nextAttempt);
    if (decision.retry) {
      const next = new Date(Date.now() + Math.max(0, decision.delayMs)).toISOString();
      const retried = runtimeQueue.markRetryingIfRunning(
        params.queueItem.id,
        `${decision.reason}: ${err.message}`,
        next,
      );
      if (retried) {
        await params.sessionManager.setStatus(params.queueItem.session_key, SessionStatus.RETRYING);
        params.schedulePump();
      }
      releaseSessionOnce();
      return;
    }
    const failed = runtimeQueue.markFailedIfRunning(
      params.queueItem.id,
      `${decision.reason}: ${err.message}`,
    );
    if (failed) {
      await params.sessionManager.setStatus(params.queueItem.session_key, SessionStatus.FAILED);
    }
    releaseSessionOnce();
    return;
  }
}

async function handleDetachedTerminal(params: {
  queueItem: RuntimeQueueItem;
  sessionManager: SessionManager;
  errorPolicy: RuntimeErrorPolicy;
  schedulePump: () => void;
  inbound: InboundMessage;
  startedAt: number;
  terminal: "completed" | "failed" | "aborted";
  error?: Error;
  reason?: string;
  errorCode?: string;
}): Promise<void> {
  if (params.terminal === "completed") {
    const completed = runtimeQueue.markCompletedIfRunning(params.queueItem.id);
    if (!completed) {
      const current = runtimeQueue.getById(params.queueItem.id);
      if (current?.status === SessionStatus.INTERRUPTED) {
        await params.sessionManager.setStatus(
          params.queueItem.session_key,
          SessionStatus.INTERRUPTED,
        );
      }
      return;
    }
    await params.sessionManager.setStatus(params.queueItem.session_key, SessionStatus.COMPLETED);
    logger.info(
      {
        queueItemId: params.queueItem.id,
        sessionKey: params.queueItem.session_key,
        messageId: params.inbound.id,
        durationMs: Date.now() - params.startedAt,
      },
      "Queue item completed",
    );

    await processPendingContinuations({
      sessionKey: params.queueItem.session_key,
      channelId: params.queueItem.channel_id,
      peerId: params.queueItem.peer_id,
      peerType: params.queueItem.peer_type,
      originalInbound: params.inbound,
      sessionManager: params.sessionManager,
      schedulePump: params.schedulePump,
    });
    return;
  }

  if (params.terminal === "aborted") {
    const interrupted = runtimeQueue.markInterruptedIfRunning(
      params.queueItem.id,
      params.reason || "Interrupted by detached run",
    );
    if (interrupted) {
      await params.sessionManager.setStatus(
        params.queueItem.session_key,
        SessionStatus.INTERRUPTED,
      );
      logger.warn(
        {
          queueItemId: params.queueItem.id,
          sessionKey: params.queueItem.session_key,
          messageId: params.inbound.id,
          reason: params.reason,
          errorCode: params.errorCode,
          durationMs: Date.now() - params.startedAt,
        },
        "Queue item interrupted while processing",
      );
    }
    return;
  }

  const err = params.error ?? new Error(params.reason ?? "Detached run failed");
  const nextAttempt = params.queueItem.attempts + 1;
  const decision = params.errorPolicy.decide(err, nextAttempt);
  if (decision.retry) {
    const next = new Date(Date.now() + Math.max(0, decision.delayMs)).toISOString();
    const retried = runtimeQueue.markRetryingIfRunning(
      params.queueItem.id,
      `${decision.reason}: ${err.message}`,
      next,
    );
    if (retried) {
      await params.sessionManager.setStatus(params.queueItem.session_key, SessionStatus.RETRYING);
      params.schedulePump();
      logger.warn(
        {
          queueItemId: params.queueItem.id,
          sessionKey: params.queueItem.session_key,
          messageId: params.inbound.id,
          attempts: params.queueItem.attempts,
          nextAttempt,
          retryAt: next,
          reason: decision.reason,
          error: err.message,
          durationMs: Date.now() - params.startedAt,
        },
        "Queue item scheduled for retry",
      );
    }
    return;
  }

  const failed = runtimeQueue.markFailedIfRunning(
    params.queueItem.id,
    `${decision.reason}: ${err.message}`,
  );
  if (failed) {
    await params.sessionManager.setStatus(params.queueItem.session_key, SessionStatus.FAILED);
    logger.error(
      {
        queueItemId: params.queueItem.id,
        sessionKey: params.queueItem.session_key,
        messageId: params.inbound.id,
        attempts: params.queueItem.attempts,
        reason: decision.reason,
        error: err.message,
        durationMs: Date.now() - params.startedAt,
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
