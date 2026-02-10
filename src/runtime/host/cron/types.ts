export type ScheduleKind = "at" | "every" | "cron";

export interface ScheduleAt {
  kind: "at";
  atMs: number; // Unix timestamp
}

export interface ScheduleEvery {
  kind: "every";
  everyMs: number;
  anchorMs?: number;
}

export interface ScheduleCron {
  kind: "cron";
  expr: string;
  tz?: string;
}

export type Schedule = ScheduleAt | ScheduleEvery | ScheduleCron;

export interface CronJob {
  id: string;
  name?: string;
  schedule: Schedule;
  payload: CronPayload;
  enabled: boolean;
  createdAt: Date;
  lastRunAt?: Date;
  nextRunAt?: Date;
}

export interface CronPayload {
  kind: "systemEvent" | "agentTurn" | "sendMessage";
  text?: string;
  sessionKey?: string;
  agentId?: string;

  // For sendMessage:
  channel?: string;
  target?: string; // chat id
  message?: string;
}
