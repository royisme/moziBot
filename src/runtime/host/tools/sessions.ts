import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import {
  reminderCancel as reminderCancelTool,
  reminderCancelSchema as reminderCancelToolSchema,
  reminderCreate as reminderCreateTool,
  reminderCreateSchema as reminderCreateToolSchema,
  reminderList as reminderListTool,
  reminderListSchema as reminderListToolSchema,
  reminderSnooze as reminderSnoozeTool,
  reminderSnoozeSchema as reminderSnoozeToolSchema,
  reminderUpdate as reminderUpdateTool,
  reminderUpdateSchema as reminderUpdateToolSchema,
} from "../../../agents/tools/reminders";
import {
  scheduleContinuation,
  scheduleContinuationSchema,
  sessionsHistory,
  sessionsHistorySchema,
  sessionsList,
  sessionsListSchema,
  sessionsSend,
  sessionsSendSchema,
  sessionsSpawn,
  sessionsSpawnSchema,
  type SessionToolsContext,
} from "../../../agents/tools/sessions";
import { createZodTool } from "../../tool-utils";

const SESSION_STATUS_VALUES = [
  "idle",
  "queued",
  "running",
  "retrying",
  "completed",
  "failed",
  "interrupted",
] as const;

const CLEANUP_VALUES = ["delete", "keep"] as const;
const REMINDER_SCHEDULE_KIND_VALUES = ["at", "every", "cron"] as const;

function stringEnum<const T extends readonly string[]>(values: T) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
  });
}

const reminderScheduleParameters = Type.Object({
  kind: stringEnum(REMINDER_SCHEDULE_KIND_VALUES),
  atMs: Type.Optional(Type.Number()),
  everyMs: Type.Optional(Type.Number()),
  anchorMs: Type.Optional(Type.Number()),
  expr: Type.Optional(Type.String()),
  tz: Type.Optional(Type.String()),
});

export function createSessionTools(ctx: SessionToolsContext): AgentTool[] {
  return [
    createZodTool({
      name: "sessions_list",
      label: "Sessions List",
      description: "List active sessions with optional filters",
      parameters: Type.Object({
        agentId: Type.Optional(Type.String()),
        channel: Type.Optional(Type.String()),
        status: Type.Optional(stringEnum(SESSION_STATUS_VALUES)),
        limit: Type.Optional(Type.Number()),
      }),
      schema: sessionsListSchema,
      ctx,
      execute: sessionsList,
    }),
    createZodTool({
      name: "sessions_history",
      label: "Sessions History",
      description: "Get message history for a session",
      parameters: Type.Object({
        sessionKey: Type.String({ minLength: 1 }),
        limit: Type.Optional(Type.Number()),
        includeTools: Type.Optional(Type.Boolean()),
      }),
      schema: sessionsHistorySchema,
      ctx,
      execute: sessionsHistory,
    }),
    createZodTool({
      name: "sessions_send",
      label: "Sessions Send",
      description: "Send a message to another session",
      parameters: Type.Object({
        sessionKey: Type.Optional(Type.String()),
        label: Type.Optional(Type.String()),
        message: Type.String({ minLength: 1 }),
        timeoutSeconds: Type.Optional(Type.Number()),
      }),
      schema: sessionsSendSchema,
      ctx,
      execute: sessionsSend,
    }),
    createZodTool({
      name: "sessions_spawn",
      label: "Sessions Spawn",
      description: "Spawn a sub-agent to handle a sub-task",
      parameters: Type.Object({
        task: Type.String({ minLength: 1 }),
        agentId: Type.Optional(Type.String()),
        model: Type.Optional(Type.String()),
        label: Type.Optional(Type.String()),
        cleanup: Type.Optional(stringEnum(CLEANUP_VALUES)),
        runTimeoutSeconds: Type.Optional(Type.Number()),
      }),
      schema: sessionsSpawnSchema,
      ctx,
      execute: sessionsSpawn,
    }),
    createZodTool({
      name: "schedule_continuation",
      label: "Schedule Continuation",
      description:
        "Schedule a follow-up task for yourself. Use when you need to continue working on a multi-step task after this response. The continuation will run after you send your current reply.",
      parameters: Type.Object({
        prompt: Type.String({ minLength: 1 }),
        delayMs: Type.Optional(Type.Number()),
        reason: Type.Optional(Type.String()),
        context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }),
      schema: scheduleContinuationSchema,
      ctx,
      execute: scheduleContinuation,
    }),
    createZodTool({
      name: "reminder_create",
      label: "Reminder Create",
      description: "Create a durable reminder with at/every/cron schedule",
      parameters: Type.Object({
        message: Type.String({ minLength: 1 }),
        schedule: reminderScheduleParameters,
      }),
      schema: reminderCreateToolSchema,
      ctx,
      execute: reminderCreateTool,
    }),
    createZodTool({
      name: "reminder_list",
      label: "Reminder List",
      description: "List reminders for current session",
      parameters: Type.Object({
        includeDisabled: Type.Optional(Type.Boolean()),
        limit: Type.Optional(Type.Number()),
      }),
      schema: reminderListToolSchema,
      ctx,
      execute: reminderListTool,
    }),
    createZodTool({
      name: "reminder_cancel",
      label: "Reminder Cancel",
      description: "Cancel a reminder by ID",
      parameters: Type.Object({
        reminderId: Type.String({ minLength: 1 }),
      }),
      schema: reminderCancelToolSchema,
      ctx,
      execute: reminderCancelTool,
    }),
    createZodTool({
      name: "reminder_update",
      label: "Reminder Update",
      description: "Update reminder message and schedule",
      parameters: Type.Object({
        reminderId: Type.String({ minLength: 1 }),
        message: Type.String({ minLength: 1 }),
        schedule: reminderScheduleParameters,
      }),
      schema: reminderUpdateToolSchema,
      ctx,
      execute: reminderUpdateTool,
    }),
    createZodTool({
      name: "reminder_snooze",
      label: "Reminder Snooze",
      description: "Snooze reminder by delay milliseconds",
      parameters: Type.Object({
        reminderId: Type.String({ minLength: 1 }),
        delayMs: Type.Number(),
      }),
      schema: reminderSnoozeToolSchema,
      ctx,
      execute: reminderSnoozeTool,
    }),
  ];
}
