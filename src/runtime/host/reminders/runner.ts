import { randomUUID } from "node:crypto";
import type { InboundMessage } from "../../adapters/channels/types";
import type { RuntimeKernel } from "../../core/kernel";
import type { Schedule } from "../cron/types";
import { logger } from "../../../logger";
import { reminders } from "../../../storage/db";
import { computeNextRun } from "./schedule";

export class ReminderRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly runtimeKernel: RuntimeKernel,
    private readonly pollMs: number = 1000,
    private readonly batchSize: number = 32,
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
          const inbound: InboundMessage = {
            id: queueItemId,
            channel: reminder.channel_id,
            peerId: reminder.peer_id,
            peerType: reminder.peer_type as "dm" | "group" | "channel",
            senderId: "system:reminder",
            text: reminder.message,
            timestamp: now,
            raw: {
              source: "reminder",
              reminderId: reminder.id,
              scheduledAt: fireAt.toISOString(),
            },
          };

          const dedupKey = `reminder:${reminder.id}:${fireAt.toISOString()}`;
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
