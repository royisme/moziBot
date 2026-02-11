import { randomUUID } from "node:crypto";
import type { ChannelPlugin } from "../adapters/channels/plugin";
import type { ChannelRegistry } from "../adapters/channels/registry";
import type { InboundMessage, OutboundMessage } from "../adapters/channels/types";
import type { MessageHandler } from "../host/message-handler";
import type { SessionManager } from "../host/sessions/manager";
import type {
  ContinuationRequest,
  RuntimeDeliveryReceipt,
  RuntimeEgress,
  RuntimeEnqueueResult,
  RuntimeErrorPolicy,
  RuntimeInboundEnvelope,
  RuntimeIngress,
  RuntimeQueueConfig,
  RuntimeQueueMode,
} from "./contracts";
import { logger } from "../../logger";
import { runtimeQueue, type RuntimeQueueItem } from "../../storage/db";
import { continuationRegistry } from "./continuation";
import { ChannelRuntimeEgress } from "./egress";
import { DefaultRuntimeErrorPolicy } from "./error-policy";

type RuntimeKernelOptions = {
  messageHandler: MessageHandler;
  sessionManager: SessionManager;
  channelRegistry: ChannelRegistry;
  egress?: RuntimeEgress;
  errorPolicy?: RuntimeErrorPolicy;
  pollIntervalMs?: number;
  queueConfig?: RuntimeQueueConfig;
};

const DEFAULT_QUEUE_MODE: RuntimeQueueMode = "steer-backlog";
const DEFAULT_COLLECT_WINDOW_MS = 400;

export class RuntimeKernel implements RuntimeIngress {
  private readonly messageHandler: MessageHandler;
  private readonly sessionManager: SessionManager;
  private readonly egress: RuntimeEgress;
  private readonly errorPolicy: RuntimeErrorPolicy;
  private readonly pollIntervalMs: number;
  private readonly activeSessions = new Set<string>();
  private queueConfig: Required<Pick<RuntimeQueueConfig, "mode" | "collectWindowMs">> &
    Pick<RuntimeQueueConfig, "maxBacklog"> = {
    mode: DEFAULT_QUEUE_MODE,
    collectWindowMs: DEFAULT_COLLECT_WINDOW_MS,
  };
  private pumpScheduled = false;
  private pumping = false;
  private stopped = true;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RuntimeKernelOptions) {
    this.messageHandler = options.messageHandler;
    this.sessionManager = options.sessionManager;
    this.egress = options.egress ?? new ChannelRuntimeEgress(options.channelRegistry);
    this.errorPolicy = options.errorPolicy ?? new DefaultRuntimeErrorPolicy();
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.updateQueueConfig(options.queueConfig);
  }

  updateQueueConfig(config?: RuntimeQueueConfig): void {
    this.queueConfig = {
      mode: config?.mode ?? DEFAULT_QUEUE_MODE,
      collectWindowMs: config?.collectWindowMs ?? DEFAULT_COLLECT_WINDOW_MS,
      maxBacklog: config?.maxBacklog,
    };
    logger.info(
      {
        mode: this.queueConfig.mode,
        collectWindowMs: this.queueConfig.collectWindowMs,
        maxBacklog: this.queueConfig.maxBacklog ?? null,
      },
      "Runtime queue config applied",
    );
  }

  async start(): Promise<void> {
    this.stopped = false;
    const interrupted = runtimeQueue.markInterruptedFromRunning();
    if (interrupted > 0) {
      logger.warn({ interrupted }, "Recovered running queue items as interrupted on startup");
    }
    this.schedulePump();
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.schedulePump(), this.pollIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async enqueueInbound(envelope: RuntimeInboundEnvelope): Promise<RuntimeEnqueueResult> {
    const context = this.messageHandler.resolveSessionContext(envelope.inbound);
    const text = envelope.inbound.text?.trim() ?? "";
    const commandToken = this.extractCommandToken(text);

    if (this.isStopCommand(commandToken)) {
      const interrupted = runtimeQueue.markInterruptedBySession(
        context.sessionKey,
        "Cancelled by /stop command",
      );
      continuationRegistry.cancelSession(context.sessionKey);
      const interruptSession = (
        this.messageHandler as unknown as {
          interruptSession?: (sessionKey: string, reason?: string) => Promise<boolean> | boolean;
        }
      ).interruptSession;
      if (typeof interruptSession === "function") {
        await Promise.resolve(
          interruptSession.call(
            this.messageHandler,
            context.sessionKey,
            `Cancelled by /stop command ${envelope.inbound.id}`,
          ),
        );
      }
      if (interrupted > 0) {
        logger.warn(
          {
            sessionKey: context.sessionKey,
            interrupted,
            messageId: envelope.inbound.id,
          },
          "Cancelled queued/running items for session by /stop command",
        );
      }
    }
    const queueItemId = envelope.id || randomUUID();

    if (this.queueConfig.mode === "steer" || this.queueConfig.mode === "steer-backlog") {
      const injected = await this.tryInjectIntoActiveSession({
        queueItemId,
        sessionKey: context.sessionKey,
        inbound: envelope.inbound,
        mode: this.queueConfig.mode,
      });
      if (injected) {
        return {
          accepted: true,
          deduplicated: false,
          queueItemId,
          sessionKey: context.sessionKey,
        };
      }
    }

    if (this.queueConfig.mode === "interrupt") {
      const interrupted = runtimeQueue.markInterruptedBySession(
        context.sessionKey,
        "Interrupted by newer inbound message",
      );
      if (interrupted > 0) {
        logger.warn(
          { sessionKey: context.sessionKey, interrupted },
          "Queue items interrupted for latest inbound message",
        );
      }
      const interruptSession = (
        this.messageHandler as unknown as {
          interruptSession?: (sessionKey: string, reason?: string) => Promise<boolean> | boolean;
        }
      ).interruptSession;
      if (typeof interruptSession === "function") {
        const aborted = await Promise.resolve(
          interruptSession.call(
            this.messageHandler,
            context.sessionKey,
            `Interrupted by inbound message ${envelope.inbound.id}`,
          ),
        );
        if (aborted) {
          logger.warn(
            { sessionKey: context.sessionKey, messageId: envelope.inbound.id },
            "Active session run aborted by interrupt mode",
          );
        }
      }
    }
    if (this.queueConfig.mode === "collect") {
      const collected = await this.tryCollectIntoQueued(envelope, context.sessionKey);
      if (collected) {
        return collected;
      }
    }

    const now = envelope.receivedAt.toISOString();
    const availableAt =
      this.queueConfig.mode === "collect" && this.queueConfig.collectWindowMs > 0
        ? new Date(envelope.receivedAt.getTime() + this.queueConfig.collectWindowMs).toISOString()
        : now;
    const dedupKey = envelope.dedupKey || `${envelope.inbound.channel}:${envelope.inbound.id}`;
    const inserted = runtimeQueue.enqueue({
      id: queueItemId,
      dedupKey,
      sessionKey: context.sessionKey,
      channelId: envelope.inbound.channel,
      peerId: envelope.inbound.peerId,
      peerType: envelope.inbound.peerType || "dm",
      inboundJson: JSON.stringify(envelope.inbound),
      enqueuedAt: now,
      availableAt,
    });

    if (inserted.inserted) {
      await this.sessionManager.getOrCreate(context.sessionKey, {
        agentId: context.agentId,
        channel: envelope.inbound.channel,
        peerId: envelope.inbound.peerId,
        peerType: envelope.inbound.peerType === "group" ? "group" : "dm",
        status: "queued",
      });
      await this.sessionManager.setStatus(context.sessionKey, "queued");
      this.trimSessionBacklog(context.sessionKey);
      this.schedulePump();
      logger.info(
        {
          queueItemId,
          sessionKey: context.sessionKey,
          channel: envelope.inbound.channel,
          peerId: envelope.inbound.peerId,
          messageId: envelope.inbound.id,
          queueMode: this.queueConfig.mode,
          availableAt,
        },
        "Inbound message enqueued",
      );
    } else {
      logger.info(
        {
          queueItemId,
          sessionKey: context.sessionKey,
          channel: envelope.inbound.channel,
          peerId: envelope.inbound.peerId,
          dedupKey,
          messageId: envelope.inbound.id,
        },
        "Inbound message deduplicated",
      );
    }

    return {
      accepted: inserted.inserted,
      deduplicated: !inserted.inserted,
      queueItemId,
      sessionKey: context.sessionKey,
    };
  }

  private extractCommandToken(text: string): string {
    if (!text.startsWith("/")) {
      return "";
    }
    return text.split(/\s+/, 1)[0]?.split("@", 1)[0]?.toLowerCase() ?? "";
  }

  private isStopCommand(commandToken: string): boolean {
    return commandToken === "/stop";
  }

  private async tryInjectIntoActiveSession(params: {
    queueItemId: string;
    sessionKey: string;
    inbound: InboundMessage;
    mode: "steer" | "steer-backlog";
  }): Promise<boolean> {
    const text = params.inbound.text?.trim() ?? "";
    if (!text) {
      return false;
    }
    if (text.startsWith("/")) {
      const commandToken = this.extractCommandToken(text);
      if (this.isStopCommand(commandToken)) {
        const interrupted = runtimeQueue.markInterruptedBySession(
          params.sessionKey,
          "Interrupted by /stop command",
        );
        continuationRegistry.cancelSession(params.sessionKey);
        const interruptSession = (
          this.messageHandler as unknown as {
            interruptSession?: (sessionKey: string, reason?: string) => Promise<boolean> | boolean;
          }
        ).interruptSession;
        if (typeof interruptSession === "function") {
          const aborted = await Promise.resolve(
            interruptSession.call(
              this.messageHandler,
              params.sessionKey,
              `Interrupted by stop command ${params.inbound.id}`,
            ),
          );
          if (aborted) {
            logger.warn(
              {
                sessionKey: params.sessionKey,
                messageId: params.inbound.id,
                queueMode: params.mode,
                interrupted,
              },
              "Active session run interrupted by stop command",
            );
          }
        }
      }
      return false;
    }

    if (params.mode === "steer-backlog" && this.hasActiveSession(params.sessionKey)) {
      await this.preemptActiveSessionForLatestInput(params.sessionKey, params.inbound.id);
      return false;
    }

    const inject = (
      this.messageHandler as unknown as {
        steerSession?: (
          sessionKey: string,
          text: string,
          mode: "steer" | "followup",
        ) => Promise<boolean> | boolean;
      }
    ).steerSession;
    if (typeof inject !== "function") {
      return false;
    }

    const injected = await Promise.resolve(
      inject.call(
        this.messageHandler,
        params.sessionKey,
        text,
        params.mode === "steer-backlog" ? "followup" : "steer",
      ),
    );
    if (!injected) {
      return false;
    }

    await this.sessionManager.getOrCreate(params.sessionKey, {
      agentId: this.messageHandler.resolveSessionContext(params.inbound).agentId,
      channel: params.inbound.channel,
      peerId: params.inbound.peerId,
      peerType: params.inbound.peerType === "group" ? "group" : "dm",
      status: "running",
    });
    await this.sessionManager.setStatus(params.sessionKey, "running");
    logger.info(
      {
        queueItemId: params.queueItemId,
        sessionKey: params.sessionKey,
        channel: params.inbound.channel,
        peerId: params.inbound.peerId,
        messageId: params.inbound.id,
        queueMode: params.mode,
      },
      "Inbound message injected into active session run",
    );
    return true;
  }

  private hasActiveSession(sessionKey: string): boolean {
    const isSessionActive = (
      this.messageHandler as unknown as {
        isSessionActive?: (sessionKey: string) => boolean;
      }
    ).isSessionActive;
    if (typeof isSessionActive !== "function") {
      return false;
    }
    return Boolean(isSessionActive.call(this.messageHandler, sessionKey));
  }

  private async preemptActiveSessionForLatestInput(
    sessionKey: string,
    messageId: string,
  ): Promise<void> {
    const interrupted = runtimeQueue.markInterruptedBySession(
      sessionKey,
      "Interrupted by newer inbound message",
    );
    continuationRegistry.cancelSession(sessionKey);

    const interruptSession = (
      this.messageHandler as unknown as {
        interruptSession?: (sessionKey: string, reason?: string) => Promise<boolean> | boolean;
      }
    ).interruptSession;

    let aborted = false;
    if (typeof interruptSession === "function") {
      aborted = Boolean(
        await Promise.resolve(
          interruptSession.call(
            this.messageHandler,
            sessionKey,
            `Interrupted by newer inbound message ${messageId}`,
          ),
        ),
      );
    }

    logger.warn(
      {
        sessionKey,
        messageId,
        interrupted,
        aborted,
      },
      "Preempted active session run for latest inbound message",
    );
  }

  private async tryCollectIntoQueued(
    envelope: RuntimeInboundEnvelope,
    sessionKey: string,
  ): Promise<RuntimeEnqueueResult | null> {
    if (this.queueConfig.collectWindowMs <= 0) {
      return null;
    }
    const since = new Date(
      envelope.receivedAt.getTime() - this.queueConfig.collectWindowMs,
    ).toISOString();
    const latest = runtimeQueue.findLatestQueuedBySessionSince(sessionKey, since);
    if (!latest) {
      return null;
    }

    const previous = this.parseInbound(latest.inbound_json);
    const merged = this.mergeInbound(previous, envelope.inbound, envelope.receivedAt);
    const availableAt = new Date(
      envelope.receivedAt.getTime() + this.queueConfig.collectWindowMs,
    ).toISOString();
    const updated = runtimeQueue.mergeQueuedInbound(latest.id, JSON.stringify(merged), availableAt);
    if (!updated) {
      return null;
    }

    await this.sessionManager.setStatus(sessionKey, "queued");
    this.trimSessionBacklog(sessionKey);
    logger.info(
      {
        sessionKey,
        queueItemId: latest.id,
        queueMode: this.queueConfig.mode,
        collectWindowMs: this.queueConfig.collectWindowMs,
        mergedMessageId: envelope.inbound.id,
        mergedTextLength: merged.text.length,
      },
      "Inbound message collected into queued envelope",
    );
    return {
      accepted: true,
      deduplicated: false,
      queueItemId: latest.id,
      sessionKey,
    };
  }

  private mergeInbound(
    previous: InboundMessage,
    incoming: InboundMessage,
    receivedAt: Date,
  ): InboundMessage {
    const chunks = [previous.text?.trim(), incoming.text?.trim()].filter((value): value is string =>
      Boolean(value),
    );
    const mergedText = chunks.join("\n");
    return {
      ...incoming,
      text: mergedText || incoming.text || previous.text,
      media: incoming.media?.length ? incoming.media : previous.media,
      timestamp: receivedAt,
    };
  }

  private trimSessionBacklog(sessionKey: string): void {
    const cap = this.queueConfig.maxBacklog;
    if (!cap || cap < 1) {
      return;
    }
    const pending = runtimeQueue.listPendingBySession(sessionKey);
    if (pending.length <= cap) {
      return;
    }
    const toDrop = pending.slice(0, pending.length - cap).map((item) => item.id);
    const dropped = runtimeQueue.markInterruptedByIds(toDrop, `Dropped by maxBacklog=${cap}`);
    if (dropped > 0) {
      logger.warn(
        {
          sessionKey,
          maxBacklog: cap,
          dropped,
        },
        "Queue backlog trimmed",
      );
    }
  }

  getPendingDepth(): number {
    return runtimeQueue.countPending();
  }

  getPendingDepthBySession(sessionKey: string): number {
    return runtimeQueue.countPendingBySession(sessionKey);
  }

  private schedulePump(): void {
    if (this.stopped || this.pumpScheduled) {
      return;
    }
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.stopped || this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (!this.stopped) {
        const next = this.pickNextRunnable();
        if (!next) {
          break;
        }
        const claimed = runtimeQueue.claim(next.id);
        if (!claimed) {
          continue;
        }
        logger.info(
          {
            queueItemId: next.id,
            sessionKey: next.session_key,
            channel: next.channel_id,
            peerId: next.peer_id,
            attempts: next.attempts,
          },
          "Queue item claimed",
        );
        this.activeSessions.add(next.session_key);
        void this.processOne(next).finally(() => {
          this.activeSessions.delete(next.session_key);
          this.schedulePump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  private pickNextRunnable(): RuntimeQueueItem | null {
    const candidates = runtimeQueue.listRunnable(64);
    for (const item of candidates) {
      if (!this.activeSessions.has(item.session_key)) {
        return item;
      }
    }
    return null;
  }

  private parseInbound(json: string): InboundMessage {
    const parsed = JSON.parse(json) as InboundMessage & { timestamp: string | Date };
    const timestamp =
      parsed.timestamp instanceof Date
        ? parsed.timestamp
        : new Date(parsed.timestamp || Date.now());
    return {
      ...parsed,
      timestamp,
      peerType: parsed.peerType || "dm",
    };
  }

  private buildRuntimeChannel(params: {
    queueItem: RuntimeQueueItem;
    envelopeId: string;
  }): ChannelPlugin {
    const buildReceipt = (peerId: string): RuntimeDeliveryReceipt => ({
      queueItemId: params.queueItem.id,
      envelopeId: params.envelopeId,
      sessionKey: params.queueItem.session_key,
      channelId: params.queueItem.channel_id,
      peerId,
      attempt: params.queueItem.attempts,
      status: "running",
    });
    const runtimeChannel = {
      id: params.queueItem.channel_id,
      name: "runtime-egress",
      connect: async () => {},
      disconnect: async () => {},
      getStatus: () => "connected" as const,
      isConnected: () => true,
      send: async (peerId: string, outbound: OutboundMessage) => {
        return await this.egress.deliver(outbound, buildReceipt(peerId));
      },
      beginTyping: async (peerId: string) => {
        if (!this.egress.beginTyping) {
          return undefined;
        }
        return await this.egress.beginTyping(buildReceipt(peerId));
      },
      on: () => runtimeChannel,
      once: () => runtimeChannel,
      off: () => runtimeChannel,
      emit: () => true,
      removeAllListeners: () => runtimeChannel,
    } as unknown as ChannelPlugin;
    return runtimeChannel;
  }

  private async processOne(queueItem: RuntimeQueueItem): Promise<void> {
    continuationRegistry.resumeSession(queueItem.session_key);
    const inbound = this.parseInbound(queueItem.inbound_json);
    const channel = this.buildRuntimeChannel({
      queueItem,
      envelopeId: queueItem.id,
    });
    const startedAt = Date.now();

    await this.sessionManager.setStatus(queueItem.session_key, "running");
    logger.info(
      {
        queueItemId: queueItem.id,
        sessionKey: queueItem.session_key,
        messageId: inbound.id,
        channel: inbound.channel,
        peerId: inbound.peerId,
        attempts: queueItem.attempts,
      },
      "Queue item processing started",
    );
    try {
      await this.messageHandler.handle(inbound, channel);
      const completed = runtimeQueue.markCompletedIfRunning(queueItem.id);
      if (!completed) {
        const current = runtimeQueue.getById(queueItem.id);
        if (current?.status === "interrupted") {
          await this.sessionManager.setStatus(queueItem.session_key, "interrupted");
          logger.warn(
            {
              queueItemId: queueItem.id,
              sessionKey: queueItem.session_key,
              messageId: inbound.id,
              durationMs: Date.now() - startedAt,
            },
            "Queue item ended after interruption",
          );
          return;
        }
        logger.warn(
          {
            queueItemId: queueItem.id,
            sessionKey: queueItem.session_key,
            status: current?.status,
          },
          "Skipped completion because queue item is no longer running",
        );
        return;
      }
      await this.sessionManager.setStatus(queueItem.session_key, "completed");
      logger.info(
        {
          queueItemId: queueItem.id,
          sessionKey: queueItem.session_key,
          messageId: inbound.id,
          durationMs: Date.now() - startedAt,
        },
        "Queue item completed",
      );

      await this.processPendingContinuations({
        sessionKey: queueItem.session_key,
        channelId: queueItem.channel_id,
        peerId: queueItem.peer_id,
        peerType: queueItem.peer_type,
        originalInbound: inbound,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const current = runtimeQueue.getById(queueItem.id);
      if (current?.status === "interrupted") {
        await this.sessionManager.setStatus(queueItem.session_key, "interrupted");
        logger.warn(
          {
            queueItemId: queueItem.id,
            sessionKey: queueItem.session_key,
            messageId: inbound.id,
            error: err.message,
            durationMs: Date.now() - startedAt,
          },
          "Queue item interrupted while processing",
        );
        return;
      }
      const nextAttempt = queueItem.attempts + 1;
      const decision = this.errorPolicy.decide(err, nextAttempt);
      if (decision.retry) {
        const next = new Date(Date.now() + Math.max(0, decision.delayMs)).toISOString();
        const retried = runtimeQueue.markRetryingIfRunning(
          queueItem.id,
          `${decision.reason}: ${err.message}`,
          next,
        );
        if (!retried) {
          const latest = runtimeQueue.getById(queueItem.id);
          if (latest?.status === "interrupted") {
            await this.sessionManager.setStatus(queueItem.session_key, "interrupted");
            return;
          }
          logger.warn(
            {
              queueItemId: queueItem.id,
              sessionKey: queueItem.session_key,
              status: latest?.status,
            },
            "Skipped retry because queue item is no longer running",
          );
          return;
        }
        await this.sessionManager.setStatus(queueItem.session_key, "retrying");
        logger.warn(
          {
            queueItemId: queueItem.id,
            sessionKey: queueItem.session_key,
            messageId: inbound.id,
            attempts: queueItem.attempts,
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
        queueItem.id,
        `${decision.reason}: ${err.message}`,
      );
      if (!failed) {
        const latest = runtimeQueue.getById(queueItem.id);
        if (latest?.status === "interrupted") {
          await this.sessionManager.setStatus(queueItem.session_key, "interrupted");
          return;
        }
        logger.warn(
          {
            queueItemId: queueItem.id,
            sessionKey: queueItem.session_key,
            status: latest?.status,
          },
          "Skipped failure mark because queue item is no longer running",
        );
        return;
      }
      await this.sessionManager.setStatus(queueItem.session_key, "failed");
      logger.error(
        {
          queueItemId: queueItem.id,
          sessionKey: queueItem.session_key,
          messageId: inbound.id,
          attempts: queueItem.attempts,
          reason: decision.reason,
          error: err.message,
          durationMs: Date.now() - startedAt,
        },
        "Queue item failed",
      );
    }
  }

  private async processPendingContinuations(params: {
    sessionKey: string;
    channelId: string;
    peerId: string;
    peerType: string;
    originalInbound: InboundMessage;
  }): Promise<void> {
    const continuations = continuationRegistry.consume(params.sessionKey);
    if (continuations.length === 0) {
      return;
    }

    for (const continuation of continuations) {
      await this.enqueueContinuation({
        sessionKey: params.sessionKey,
        channelId: params.channelId,
        peerId: params.peerId,
        peerType: params.peerType,
        originalInbound: params.originalInbound,
        continuation,
      });
    }
  }

  private async enqueueContinuation(params: {
    sessionKey: string;
    channelId: string;
    peerId: string;
    peerType: string;
    originalInbound: InboundMessage;
    continuation: ContinuationRequest;
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
      await this.sessionManager.setStatus(params.sessionKey, "queued");
      this.schedulePump();
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
}
