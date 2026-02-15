import { randomUUID } from "node:crypto";
import type { ChannelPlugin } from "../adapters/channels/plugin";
import type { ChannelRegistry } from "../adapters/channels/registry";
import type { InboundMessage } from "../adapters/channels/types";
import type { MessageHandler } from "../host/message-handler";
import type { SessionManager } from "../host/sessions/manager";
import type {
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
import { QueueMode, PeerType, SessionStatus } from "./constants";
import { ChannelRuntimeEgress } from "./egress";
import { DefaultRuntimeErrorPolicy } from "./error-policy";
import { createRuntimeChannel } from "./kernel/channel-factory";
import { handleInterruptMode, handleStopCommand } from "./kernel/enqueue-coordinator";
import { tryInjectIntoActiveSession as tryInjectIntoActiveSessionHelper } from "./kernel/enqueue-policy";
import {
  extractCommandToken as extractCommandTokenHelper,
  isStopCommand as isStopCommandHelper,
  parseInbound as parseInboundHelper,
  tryCollectIntoQueued as tryCollectIntoQueuedHelper,
} from "./kernel/inbound-collector";
import { runPumpLoop, schedulePumpRunner, type PumpRunnerState } from "./kernel/pump-runner";
import { processQueueItem } from "./kernel/queue-item-processor";

type RuntimeKernelOptions = {
  messageHandler: MessageHandler;
  sessionManager: SessionManager;
  channelRegistry: ChannelRegistry;
  egress?: RuntimeEgress;
  errorPolicy?: RuntimeErrorPolicy;
  pollIntervalMs?: number;
  queueConfig?: RuntimeQueueConfig;
};

const DEFAULT_QUEUE_MODE: RuntimeQueueMode = QueueMode.STEER_BACKLOG;
const DEFAULT_COLLECT_WINDOW_MS = 400;

export class RuntimeKernel implements RuntimeIngress {
  private readonly messageHandler: MessageHandler;
  private readonly sessionManager: SessionManager;
  private readonly egress: RuntimeEgress;
  private readonly errorPolicy: RuntimeErrorPolicy;
  private readonly pollIntervalMs: number;
  private readonly pumpState: PumpRunnerState = {
    activeSessions: new Set<string>(),
    pumpScheduled: false,
    pumping: false,
  };
  private queueConfig: Required<Pick<RuntimeQueueConfig, "mode" | "collectWindowMs">> &
    Pick<RuntimeQueueConfig, "maxBacklog"> = {
    mode: DEFAULT_QUEUE_MODE,
    collectWindowMs: DEFAULT_COLLECT_WINDOW_MS,
  };
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
    const context = this.resolveSessionContext(envelope.inbound);
    const text = envelope.inbound.text?.trim() ?? "";
    const commandToken = this.extractCommandToken(text);

    if (this.isStopCommand(commandToken)) {
      await handleStopCommand({
        messageHandler: this.messageHandler,
        sessionKey: context.sessionKey,
        inbound: envelope.inbound,
      });
    }
    const queueItemId = envelope.id || randomUUID();

    if (
      this.queueConfig.mode === QueueMode.STEER ||
      this.queueConfig.mode === QueueMode.STEER_BACKLOG
    ) {
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

    if (this.queueConfig.mode === QueueMode.INTERRUPT) {
      await handleInterruptMode({
        messageHandler: this.messageHandler,
        sessionKey: context.sessionKey,
        inbound: envelope.inbound,
      });
    }
    if (this.queueConfig.mode === QueueMode.COLLECT) {
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
      peerType: envelope.inbound.peerType || PeerType.DM,
      inboundJson: JSON.stringify(envelope.inbound),
      enqueuedAt: now,
      availableAt,
    });

    if (inserted.inserted) {
      await this.sessionManager.getOrCreate(context.sessionKey, {
        agentId: context.agentId,
        channel: envelope.inbound.channel,
        peerId: envelope.inbound.peerId,
        peerType: envelope.inbound.peerType === PeerType.GROUP ? PeerType.GROUP : PeerType.DM,
        status: SessionStatus.QUEUED,
      });
      await this.sessionManager.setStatus(context.sessionKey, SessionStatus.QUEUED);
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
    return extractCommandTokenHelper(text);
  }

  private isStopCommand(commandToken: string): boolean {
    return isStopCommandHelper(commandToken);
  }

  private resolveSessionContext(inbound: InboundMessage): { sessionKey: string; agentId: string } {
    const resolver = (
      this.messageHandler as unknown as {
        resolveSessionContext?: (payload: unknown) => { sessionKey: string; agentId: string };
      }
    ).resolveSessionContext;
    if (typeof resolver === "function") {
      return resolver.call(this.messageHandler, inbound);
    }
    return {
      sessionKey: `${inbound.channel}:${inbound.peerType || PeerType.DM}:${inbound.peerId}`,
      agentId: "mozi",
    };
  }

  private async tryInjectIntoActiveSession(params: {
    queueItemId: string;
    sessionKey: string;
    inbound: InboundMessage;
    mode: "steer" | "steer-backlog";
  }): Promise<boolean> {
    return await tryInjectIntoActiveSessionHelper({
      messageHandler: this.messageHandler,
      sessionManager: this.sessionManager,
      resolveSessionContext: (inbound) => this.resolveSessionContext(inbound),
      extractCommandToken: (text) => this.extractCommandToken(text),
      isStopCommand: (commandToken) => this.isStopCommand(commandToken),
      ...params,
    });
  }

  private async tryCollectIntoQueued(
    envelope: RuntimeInboundEnvelope,
    sessionKey: string,
  ): Promise<RuntimeEnqueueResult | null> {
    return await tryCollectIntoQueuedHelper({
      envelope,
      sessionKey,
      queueMode: this.queueConfig.mode,
      collectWindowMs: this.queueConfig.collectWindowMs,
      sessionManager: this.sessionManager,
      trimSessionBacklog: (targetSessionKey) => this.trimSessionBacklog(targetSessionKey),
    });
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
    schedulePumpRunner({
      isStopped: () => this.stopped,
      state: this.pumpState,
      runPump: async () => await this.pump(),
    });
  }

  private async pump(): Promise<void> {
    await runPumpLoop({
      isStopped: () => this.stopped,
      state: this.pumpState,
      processOne: async (queueItem) => await this.processOne(queueItem),
      schedulePump: () => this.schedulePump(),
    });
  }

  private parseInbound(json: string): InboundMessage {
    return parseInboundHelper(json);
  }

  private buildRuntimeChannel(params: {
    queueItem: RuntimeQueueItem;
    envelopeId: string;
  }): ChannelPlugin {
    return createRuntimeChannel({
      ...params,
      egress: this.egress,
    });
  }

  private async processOne(queueItem: RuntimeQueueItem): Promise<void> {
    await processQueueItem({
      queueItem,
      messageHandler: this.messageHandler,
      sessionManager: this.sessionManager,
      errorPolicy: this.errorPolicy,
      parseInbound: (json) => this.parseInbound(json),
      buildRuntimeChannel: (params) => this.buildRuntimeChannel(params),
      schedulePump: () => this.schedulePump(),
    });
  }
}
