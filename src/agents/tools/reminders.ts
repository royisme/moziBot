import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Schedule } from "../../runtime/host/cron/types";
import type { SessionToolsContext } from "./sessions";
import { computeNextRun } from "../../runtime/host/reminders/schedule";
import { reminders } from "../../storage/db";

const scheduleSchema = z.union([
  z.object({
    kind: z.literal("at"),
    atMs: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("every"),
    everyMs: z.number().int().positive(),
    anchorMs: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("cron"),
    expr: z.string().min(1),
    tz: z.string().min(1).optional(),
  }),
]);

export const reminderCreateSchema = z.object({
  message: z.string().min(1),
  schedule: scheduleSchema,
});

export const reminderListSchema = z.object({
  includeDisabled: z.boolean().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

export const reminderCancelSchema = z.object({
  reminderId: z.string().min(1),
});

export const reminderUpdateSchema = z.object({
  reminderId: z.string().min(1),
  message: z.string().min(1),
  schedule: scheduleSchema,
});

export const reminderSnoozeSchema = z.object({
  reminderId: z.string().min(1),
  delayMs: z.number().int().positive(),
});

export async function reminderCreate(
  ctx: SessionToolsContext,
  params: z.infer<typeof reminderCreateSchema>,
): Promise<{ created: boolean; reminderId: string; nextRunAt: string; message: string }> {
  const session = ctx.sessionManager.get(ctx.currentSessionKey);
  if (!session) {
    throw new Error(`Session not found: ${ctx.currentSessionKey}`);
  }

  const schedule = params.schedule as Schedule;
  const nextRun = computeNextRun(schedule);
  if (!nextRun) {
    throw new Error("Schedule does not produce a future run");
  }

  const reminderId = randomUUID();
  reminders.create({
    id: reminderId,
    sessionKey: ctx.currentSessionKey,
    channelId: session.channel,
    peerId: session.peerId,
    peerType: session.peerType,
    message: params.message,
    scheduleKind: schedule.kind,
    scheduleJson: JSON.stringify(schedule),
    nextRunAt: nextRun.toISOString(),
  });

  return {
    created: true,
    reminderId,
    nextRunAt: nextRun.toISOString(),
    message: `Reminder ${reminderId} scheduled for ${nextRun.toISOString()}`,
  };
}

export async function reminderList(
  ctx: SessionToolsContext,
  params: z.infer<typeof reminderListSchema>,
): Promise<{
  reminders: Array<{
    id: string;
    enabled: boolean;
    message: string;
    scheduleKind: "at" | "every" | "cron";
    schedule: Schedule;
    nextRunAt: string | null;
    lastRunAt: string | null;
    cancelledAt: string | null;
  }>;
}> {
  const rows = reminders.listBySession(ctx.currentSessionKey, {
    includeDisabled: params.includeDisabled,
    limit: params.limit,
  });

  return {
    reminders: rows.map((row) => ({
      id: row.id,
      enabled: row.enabled === 1,
      message: row.message,
      scheduleKind: row.schedule_kind,
      schedule: JSON.parse(row.schedule_json) as Schedule,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      cancelledAt: row.cancelled_at,
    })),
  };
}

export async function reminderCancel(
  ctx: SessionToolsContext,
  params: z.infer<typeof reminderCancelSchema>,
): Promise<{ cancelled: boolean; message: string }> {
  const cancelled = reminders.cancelBySession(params.reminderId, ctx.currentSessionKey);
  return {
    cancelled,
    message: cancelled
      ? `Reminder ${params.reminderId} cancelled`
      : `Reminder ${params.reminderId} not found or already cancelled`,
  };
}

export async function reminderUpdate(
  ctx: SessionToolsContext,
  params: z.infer<typeof reminderUpdateSchema>,
): Promise<{ updated: boolean; nextRunAt: string | null; message: string }> {
  const schedule = params.schedule as Schedule;
  const nextRun = computeNextRun(schedule);
  const nextRunAt = nextRun ? nextRun.toISOString() : null;
  const updated = reminders.updateBySession({
    id: params.reminderId,
    sessionKey: ctx.currentSessionKey,
    message: params.message,
    scheduleKind: schedule.kind,
    scheduleJson: JSON.stringify(schedule),
    nextRunAt,
  });
  return {
    updated,
    nextRunAt,
    message: updated
      ? `Reminder ${params.reminderId} updated`
      : `Reminder ${params.reminderId} not found`,
  };
}

export async function reminderSnooze(
  ctx: SessionToolsContext,
  params: z.infer<typeof reminderSnoozeSchema>,
): Promise<{ snoozed: boolean; nextRunAt: string; message: string }> {
  const nextRunAt = new Date(Date.now() + params.delayMs).toISOString();
  const snoozed = reminders.updateNextRunBySession({
    id: params.reminderId,
    sessionKey: ctx.currentSessionKey,
    nextRunAt,
  });
  return {
    snoozed,
    nextRunAt,
    message: snoozed
      ? `Reminder ${params.reminderId} snoozed until ${nextRunAt}`
      : `Reminder ${params.reminderId} not found`,
  };
}
