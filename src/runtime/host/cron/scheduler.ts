import * as parser from "cron-parser";
import type { CronJob, Schedule } from "./types";
import { logger } from "../../../logger";
import { ChannelRegistry } from "../../adapters/channels/registry";

export class CronScheduler {
  private jobs: Map<string, CronJob> = new Map();
  private timers: Map<string, Timer> = new Map();
  private handler?: (job: CronJob) => Promise<void>;
  private channelRegistry?: ChannelRegistry;

  constructor(channelRegistry?: ChannelRegistry) {
    this.channelRegistry = channelRegistry;
  }

  setHandler(handler: (job: CronJob) => Promise<void>): void {
    this.handler = handler;
  }

  add(job: CronJob): void {
    if (this.jobs.has(job.id)) {
      this.remove(job.id);
    }
    this.jobs.set(job.id, job);
    if (job.enabled) {
      this.scheduleJob(job);
    }
  }

  update(id: string, changes: Partial<CronJob>): void {
    const job = this.jobs.get(id);
    if (!job) {
      return;
    }

    const updatedJob = { ...job, ...changes };
    this.jobs.set(id, updatedJob);

    // If enabled state changed or schedule changed, reschedule
    this.scheduleJob(updatedJob);
  }

  remove(id: string): void {
    this.jobs.delete(id);
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  get(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  list(includeDisabled = false): CronJob[] {
    const all = Array.from(this.jobs.values());
    if (includeDisabled) {
      return all;
    }
    return all.filter((j) => j.enabled);
  }

  // Calculate next run time
  private calculateNextRun(schedule: Schedule, nowMs: number = Date.now()): Date | undefined {
    if (schedule.kind === "at") {
      return schedule.atMs > nowMs ? new Date(schedule.atMs) : undefined;
    }

    if (schedule.kind === "every") {
      const everyMs = Math.max(1, Math.floor(schedule.everyMs));
      const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? nowMs));
      if (nowMs < anchor) {
        return new Date(anchor);
      }
      const elapsed = nowMs - anchor;
      const steps = Math.max(1, Math.floor((elapsed + everyMs) / everyMs));
      return new Date(anchor + steps * everyMs);
    }

    if (schedule.kind === "cron") {
      try {
        const interval = parser.default.parse(schedule.expr, {
          currentDate: new Date(nowMs),
          tz: schedule.tz,
        });
        return interval.next().toDate();
      } catch (err) {
        logger.error(`Failed to parse cron expression: ${schedule.expr}`, err);
        return undefined;
      }
    }

    return undefined;
  }

  // Schedule the timer
  private scheduleJob(job: CronJob): void {
    // Clear existing timer if any
    const existingTimer = this.timers.get(job.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.timers.delete(job.id);
    }

    if (!job.enabled) {
      job.nextRunAt = undefined;
      return;
    }

    const nowMs = Date.now();
    const nextRun = this.calculateNextRun(job.schedule, nowMs);
    job.nextRunAt = nextRun;

    if (!nextRun) {
      if (job.schedule.kind === "at" && job.schedule.atMs <= nowMs) {
        job.enabled = false;
      }
      return;
    }

    const delay = nextRun.getTime() - nowMs;
    const safeDelay = Math.max(0, delay);

    // Limit delay to 32-bit signed integer max to avoid issues with long timeouts
    // though for a cron scheduler it might be better to re-sync periodically if delay is very long.
    // However, 2^31 - 1 ms is ~24.8 days.
    const MAX_TIMEOUT = 2147483647;

    if (safeDelay > MAX_TIMEOUT) {
      // Just wait MAX_TIMEOUT and then reschedule.
      const timer = setTimeout(() => {
        this.timers.delete(job.id);
        this.scheduleJob(job);
      }, MAX_TIMEOUT);
      this.timers.set(job.id, timer);
      return;
    }

    const timer = setTimeout(async () => {
      this.timers.delete(job.id);

      try {
        if (job.payload.kind === "sendMessage") {
          await this.handleSendMessage(job);
        } else if (this.handler) {
          job.lastRunAt = new Date();
          await this.handler(job);
        }
      } catch (err) {
        logger.error(`Error running cron job ${job.id}:`, err);
      }

      // Reschedule if it's recurring
      if (job.schedule.kind !== "at") {
        this.scheduleJob(job);
      } else {
        job.enabled = false;
        job.nextRunAt = undefined;
      }
    }, safeDelay);

    this.timers.set(job.id, timer);
  }

  // Start all enabled jobs
  start(): void {
    for (const job of this.jobs.values()) {
      if (job.enabled) {
        this.scheduleJob(job);
      }
    }
  }

  // Stop all timers
  stop(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private async handleSendMessage(job: CronJob): Promise<void> {
    const { channel, target, message } = job.payload;
    if (!channel || !target || !message) {
      logger.warn(`Missing required fields for sendMessage job ${job.id}`);
      return;
    }

    if (!this.channelRegistry) {
      logger.error(`Channel registry not available for sendMessage job ${job.id}`);
      return;
    }

    const plugin = this.channelRegistry.get(channel);
    if (!plugin) {
      logger.error(`Channel plugin ${channel} not found for sendMessage job ${job.id}`);
      return;
    }

    job.lastRunAt = new Date();
    await plugin.send(target, { text: message });
    logger.info({ jobId: job.id, channel, target }, "Scheduled message sent");
  }
}
