import { randomUUID } from "node:crypto";
import { logger } from "../../../logger";
import { reminders } from "../../../storage/db";
import type { InboundMessage } from "../../adapters/channels/types";
import type { RuntimeKernel } from "../../core/kernel";
import type { AgentJobRegistry, AgentJobRunner } from "../../jobs";
import type { Schedule } from "../cron/types";
import { normalizeRouteContext } from "../routing/route-context";
import { computeNextRun } from "./schedule";

export class ReminderRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly runtimeKernel: RuntimeKernel,
    private readonly pollMs: number = 1000,
    private readonly batchSize: number = 32,
    private readonly options: {
      jobRunner?: AgentJobRunner;
      jobRegistry?: AgentJobRegistry;
    } = {},
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(
      () => {
        void this.tick();
      },
      Math.max(250, this.pollMs),
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const now = new Date();
      const due = reminders.listDue(now.toISOString(), this.batchSize);
      for (const reminder of due) {
        try {
          const schedule = JSON.parse(reminder.schedule_json) as Schedule;
          const fireAt = reminder.next_run_at ? new Date(reminder.next_run_at) : now;
          const nextRun =
            schedule.kind === "at" ? null : computeNextRun(schedule, fireAt.getTime() + 1);
          const next = nextRun ? nextRun.toISOString() : null;
          const keepEnabled = schedule.kind !== "at" && Boolean(next);
          const advanced = reminders.markFired({
            id: reminder.id,
            expectedNextRunAt: fireAt.toISOString(),
            firedAt: now.toISOString(),
            nextRunAt: next,
            enabled: keepEnabled,
          });
          if (!advanced) {
            continue;
          }

          const queueItemId = randomUUID();
          const route = normalizeRouteContext({
            channelId: reminder.channel_id,
            peerId: reminder.peer_id,
            peerType: parsePeerType(reminder.peer_type),
            accountId: reminder.account_id ?? undefined,
            threadId: reminder.thread_id ?? undefined,
            replyToId: reminder.reply_to_id ?? undefined,
          });
          const inbound: InboundMessage = {
            id: queueItemId,
            channel: route.channelId,
            peerId: route.peerId,
            peerType: route.peerType,
            senderId: "system:reminder",
            text: reminder.message,
            accountId: route.accountId,
            threadId: route.threadId,
            replyToId: route.replyToId,
            timestamp: now,
            raw: {
              source: "reminder",
              reminderId: reminder.id,
              scheduledAt: fireAt.toISOString(),
              route,
            },
          };

          const dedupKey = `reminder:${reminder.id}:${fireAt.toISOString()}`;
          if (this.options.jobRunner && this.options.jobRegistry) {
            const job = this.options.jobRegistry.create({
              id: queueItemId,
              sessionKey: reminder.session_key,
              agentId: reminder.session_key.split(":")[1] || "mozi",
              route,
              source: "reminder",
              kind: "scheduled",
              prompt: reminder.message,
              traceId: dedupKey,
              createdAt: now.getTime(),
            });
            await this.options.jobRunner.run(job);
            logger.info(
              {
                reminderId: reminder.id,
                queueItemId,
                sessionKey: reminder.session_key,
                scheduledAt: fireAt.toISOString(),
                nextRunAt: next,
              },
              "Reminder job executed",
            );
          } else {
            await this.runtimeKernel.enqueueInbound({
              id: queueItemId,
              dedupKey,
              inbound,
              receivedAt: now,
            });

            logger.info(
              {
                reminderId: reminder.id,
                queueItemId,
                sessionKey: reminder.session_key,
                scheduledAt: fireAt.toISOString(),
                nextRunAt: next,
              },
              "Reminder enqueued",
            );
          }
        } catch (error) {
          logger.error(
            {
              reminderId: reminder.id,
              error: error instanceof Error ? error.message : String(error),
            },
            "Reminder tick failed for reminder",
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}

function parsePeerType(value: string): "dm" | "group" | "channel" {
  if (value === "group" || value === "channel") {
    return value;
  }
  return "dm";
}
