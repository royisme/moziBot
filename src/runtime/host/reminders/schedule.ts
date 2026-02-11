import * as parser from "cron-parser";
import type { Schedule } from "../cron/types";

export function computeNextRun(schedule: Schedule, nowMs: number = Date.now()): Date | null {
  if (schedule.kind === "at") {
    return schedule.atMs > nowMs ? new Date(schedule.atMs) : null;
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

  try {
    const interval = parser.default.parse(schedule.expr, {
      currentDate: new Date(nowMs),
      tz: schedule.tz,
    });
    return interval.next().toDate();
  } catch {
    return null;
  }
}
