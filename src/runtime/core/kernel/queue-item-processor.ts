import { randomUUID } from "node:crypto";
import { logger } from "../../../logger";
import { runtimeQueue, type RuntimeQueueItem } from "../../../storage/db";
import type { ChannelPlugin } from "../../adapters/channels/plugin";
import type { InboundMessage } from "../../adapters/channels/types";
import type { MessageHandler } from "../../host/message-handler";
import { startDetachedRun as startDetachedRunService } from "../../host/message-handler/services/run-dispatch";
import { normalizeRouteContext, routeContextFromInbound } from "../../host/routing/route-context";
import type { RouteContext } from "../../host/routing/types";
import type { SessionManager } from "../../host/sessions/manager";
import type { AgentJobRegistry, AgentJobRunner } from "../../jobs";
import { SessionStatus } from "../constants";
import { continuationRegistry } from "../continuation";
import type { RuntimeErrorPolicy, SubagentResultPayload } from "../contracts";

type RouteLike = {
  channelId?: unknown;
  peerId?: unknown;
  peerType?: unknown;
  accountId?: unknown;
  threadId?: unknown;
  replyToId?: unknown;
};

function resolveContinuationRoute(rawRoute: unknown, inbound: InboundMessage): RouteContext {
  if (!rawRoute || typeof rawRoute !== "object") {
    return routeContextFromInbound(inbound);
  }

  const routeCandidate = rawRoute as RouteLike;
  if (typeof routeCandidate.channelId !== "string" || typeof routeCandidate.peerId !== "string") {
    return routeContextFromInbound(inbound);
  }

  const peerType: RouteContext["peerType"] =
    routeCandidate.peerType === "group" || routeCandidate.peerType === "channel"
      ? routeCandidate.peerType
      : "dm";

  return normalizeRouteContext({
    channelId: routeCandidate.channelId,
    peerId: routeCandidate.peerId,
    peerType,
    accountId:
      typeof routeCandidate.accountId === "string" || typeof routeCandidate.accountId === "number"
        ? routeCandidate.accountId
        : undefined,
    threadId:
      typeof routeCandidate.threadId === "string" || typeof routeCandidate.threadId === "number"
        ? routeCandidate.threadId
        : undefined,
    replyToId:
      typeof routeCandidate.replyToId === "string" || typeof routeCandidate.replyToId === "number"
        ? routeCandidate.replyToId
        : undefined,
  });
}

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
  agentJobRunner?: AgentJobRunner;
  agentJobRegistry?: AgentJobRegistry;
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
    // Type dispatch: non-user_message events are handled separately
    const eventType = params.queueItem.event_type ?? "user_message";
    if (eventType !== "user_message") {
      await handleNonUserEvent({
        queueItem: params.queueItem,
        messageHandler: params.messageHandler,
      });
      runtimeQueue.markCompletedIfRunning(params.queueItem.id);
      releaseSessionOnce();
      return;
    }

    continuationRegistry.resumeSession(params.queueItem.session_key);
    const inbound = params.parseInbound(params.queueItem.inbound_json);
    const channel = params.buildRuntimeChannel({
      queueItem: params.queueItem,
      envelopeId: params.queueItem.id,
    });
    const startedAt = Date.now();

    if (
      inbound.raw &&
      typeof inbound.raw === "object" &&
      (inbound.raw as { source?: unknown }).source === "continuation" &&
      params.agentJobRunner &&
      params.agentJobRegistry
    ) {
      const continuationRaw = inbound.raw as {
        reason?: unknown;
        context?: unknown;
        parentMessageId?: unknown;
        parentQueueItemId?: unknown;
        route?: unknown;
      };
      const inheritedRoute = resolveContinuationRoute(continuationRaw.route, inbound);
      const job = params.agentJobRegistry.create({
        id: params.queueItem.id,
        sessionKey: params.queueItem.session_key,
        agentId: inbound.channel
          ? params.messageHandler.resolveSessionContext(inbound).agentId
          : "mozi",
        route: inheritedRoute,
        source: "tool",
        kind: "followup",
        prompt: inbound.text ?? "",
        metadata: {
          continuation: {
            reason: continuationRaw.reason,
            context: continuationRaw.context,
            parentMessageId: continuationRaw.parentMessageId,
            parentQueueItemId: continuationRaw.parentQueueItemId,
          },
        },
        parentJobId:
          typeof continuationRaw.parentQueueItemId === "string"
            ? continuationRaw.parentQueueItemId
            : undefined,
        traceId: `turn:${inbound.id}`,
        createdAt: startedAt,
      });

      await params.sessionManager.setStatus(params.queueItem.session_key, SessionStatus.RUNNING);
      const result = await params.agentJobRunner.run(job);
      await handleDetachedTerminal({
        ...params,
        inbound,
        startedAt,
        terminal: result.snapshot.status === "completed" ? "completed" : "failed",
        reason: result.snapshot.error,
      });
      releaseSessionOnce();
      return;
    }

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
      route: routeContextFromInbound(params.inbound),
      originalInbound: params.inbound,
      parentQueueItemId: params.queueItem.id,
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
  route: RouteContext;
  originalInbound: InboundMessage;
  parentQueueItemId: string;
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

async function handleNonUserEvent(params: {
  queueItem: RuntimeQueueItem;
  messageHandler: MessageHandler;
}): Promise<void> {
  const payload = params.queueItem.event_payload
    ? (JSON.parse(params.queueItem.event_payload) as Record<string, unknown>)
    : {};
  switch (params.queueItem.event_type) {
    case "internal": {
      await params.messageHandler.handleInternalMessageQueued(payload);
      break;
    }
    case "subagent_result": {
      await params.messageHandler.handleSubagentResult(payload as SubagentResultPayload);
      break;
    }
    case "watchdog_wake": {
      await params.messageHandler.handleWatchdogWake({
        sessionKey: params.queueItem.session_key,
        agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
        prompt: typeof payload.prompt === "string" ? payload.prompt : undefined,
      });
      break;
    }
    default:
      // cron_fire, reminder — not yet handled; log and skip
      console.warn(`[queue] unhandled event_type: ${params.queueItem.event_type}`);
  }
}

async function enqueueContinuation(params: {
  sessionKey: string;
  route: RouteContext;
  originalInbound: InboundMessage;
  parentQueueItemId: string;
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
    channel: params.route.channelId,
    peerId: params.route.peerId,
    peerType: params.route.peerType,
    senderId: params.originalInbound.senderId,
    text: params.continuation.prompt,
    accountId: params.route.accountId,
    threadId: params.route.threadId,
    replyToId: params.route.replyToId,
    timestamp: now,
    raw: {
      source: "continuation",
      reason: params.continuation.reason,
      context: params.continuation.context,
      parentMessageId: params.originalInbound.id,
      parentQueueItemId: params.parentQueueItemId,
      route: params.route,
    },
  };

  const inserted = runtimeQueue.enqueue({
    id: queueItemId,
    dedupKey,
    sessionKey: params.sessionKey,
    channelId: params.route.channelId,
    peerId: params.route.peerId,
    peerType: params.route.peerType,
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
