import { randomUUID } from "node:crypto";
import type { InboundMessage } from "../../../adapters/channels/types";
import type { Schedule } from "../../cron/types";
import { reminders } from "../../../../storage/db";
import { computeNextRun } from "../../reminders/schedule";

interface SendChannel {
  send(peerId: string, payload: { text: string }): Promise<unknown>;
}

function parseDurationMs(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const matched = trimmed.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!matched) {
    return null;
  }
  const amount = Number(matched[1]);
  const unit = matched[2];
  if (unit === "ms") {
    return amount;
  }
  if (unit === "s") {
    return amount * 1000;
  }
  if (unit === "m") {
    return amount * 60_000;
  }
  if (unit === "h") {
    return amount * 3_600_000;
  }
  return amount * 86_400_000;
}

function parseAtMs(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}

export async function handleRemindersCommand(params: {
  sessionKey: string;
  message: InboundMessage;
  channel: SendChannel;
  peerId: string;
  args: string;
}): Promise<void> {
  const { sessionKey, message, channel, peerId, args } = params;
  const raw = args.trim();

  if (!raw || /^list(?:\s+all)?(?:\s+\d+)?$/i.test(raw)) {
    const listMatched = raw.match(/^list(?:\s+(all))?(?:\s+(\d+))?$/i);
    const includeDisabled = Boolean(listMatched?.[1]);
    const limit = listMatched?.[2] ? Math.max(1, Number(listMatched[2])) : 20;
    const rows = reminders.listBySession(sessionKey, { includeDisabled, limit });
    if (rows.length === 0) {
      await channel.send(peerId, { text: "No reminders." });
      return;
    }
    const lines = ["Reminders:"];
    for (const row of rows) {
      const status = row.enabled === 1 ? "enabled" : "disabled";
      lines.push(
        `- ${row.id} [${status}] next=${row.next_run_at ?? "none"} msg=${row.message.slice(0, 80)}`,
      );
    }
    await channel.send(peerId, { text: lines.join("\n") });
    return;
  }

  const createMatched = raw.match(/^(?:create|add)\s+(in|every|at)\s+(\S+)\s+([\s\S]+)$/i);
  if (createMatched) {
    const mode = createMatched[1].toLowerCase();
    const timeArg = createMatched[2];
    const reminderText = createMatched[3].trim();
    if (!reminderText) {
      await channel.send(peerId, { text: "Reminder message cannot be empty." });
      return;
    }
    const now = Date.now();
    let schedule: Schedule;
    if (mode === "in") {
      const durationMs = parseDurationMs(timeArg);
      if (!durationMs || durationMs <= 0) {
        await channel.send(peerId, { text: "Invalid duration. Example: 10m, 30s, 5000" });
        return;
      }
      schedule = { kind: "at", atMs: now + durationMs };
    } else if (mode === "every") {
      const durationMs = parseDurationMs(timeArg);
      if (!durationMs || durationMs <= 0) {
        await channel.send(peerId, { text: "Invalid interval. Example: 10m, 1h, 60000" });
        return;
      }
      schedule = { kind: "every", everyMs: durationMs, anchorMs: now };
    } else {
      const atMs = parseAtMs(timeArg);
      if (!atMs) {
        await channel.send(peerId, {
          text: "Invalid at time. Use unix ms or ISO datetime (quoted).",
        });
        return;
      }
      schedule = { kind: "at", atMs };
    }
    const nextRun = computeNextRun(schedule, now);
    if (!nextRun) {
      await channel.send(peerId, { text: "Schedule has no future run." });
      return;
    }
    const reminderId = randomUUID();
    reminders.create({
      id: reminderId,
      sessionKey,
      channelId: message.channel,
      peerId: message.peerId,
      peerType: message.peerType ?? "dm",
      message: reminderText,
      scheduleKind: schedule.kind,
      scheduleJson: JSON.stringify(schedule),
      nextRunAt: nextRun.toISOString(),
    });
    await channel.send(peerId, {
      text: `Reminder created: ${reminderId}\nnextRunAt: ${nextRun.toISOString()}`,
    });
    return;
  }

  const updateMatched = raw.match(/^(?:update)\s+(\S+)\s+(in|every|at)\s+(\S+)\s+([\s\S]+)$/i);
  if (updateMatched) {
    const reminderId = updateMatched[1];
    const mode = updateMatched[2].toLowerCase();
    const timeArg = updateMatched[3];
    const reminderText = updateMatched[4].trim();
    if (!reminderText) {
      await channel.send(peerId, { text: "Reminder message cannot be empty." });
      return;
    }
    const now = Date.now();
    let schedule: Schedule;
    if (mode === "in") {
      const durationMs = parseDurationMs(timeArg);
      if (!durationMs || durationMs <= 0) {
        await channel.send(peerId, { text: "Invalid duration. Example: 10m, 30s, 5000" });
        return;
      }
      schedule = { kind: "at", atMs: now + durationMs };
    } else if (mode === "every") {
      const durationMs = parseDurationMs(timeArg);
      if (!durationMs || durationMs <= 0) {
        await channel.send(peerId, { text: "Invalid interval. Example: 10m, 1h, 60000" });
        return;
      }
      schedule = { kind: "every", everyMs: durationMs, anchorMs: now };
    } else {
      const atMs = parseAtMs(timeArg);
      if (!atMs) {
        await channel.send(peerId, {
          text: "Invalid at time. Use unix ms or ISO datetime (quoted).",
        });
        return;
      }
      schedule = { kind: "at", atMs };
    }
    const nextRun = computeNextRun(schedule, now);
    const updated = reminders.updateBySession({
      id: reminderId,
      sessionKey,
      message: reminderText,
      scheduleKind: schedule.kind,
      scheduleJson: JSON.stringify(schedule),
      nextRunAt: nextRun ? nextRun.toISOString() : null,
    });
    await channel.send(peerId, {
      text: updated
        ? `Reminder updated: ${reminderId}\nnextRunAt: ${nextRun ? nextRun.toISOString() : "none"}`
        : `Reminder not found: ${reminderId}`,
    });
    return;
  }

  const cancelMatched = raw.match(/^cancel\s+(\S+)$/i);
  if (cancelMatched) {
    const reminderId = cancelMatched[1];
    const cancelled = reminders.cancelBySession(reminderId, sessionKey);
    await channel.send(peerId, {
      text: cancelled ? `Reminder cancelled: ${reminderId}` : `Reminder not found: ${reminderId}`,
    });
    return;
  }

  const snoozeMatched = raw.match(/^snooze\s+(\S+)\s+(\S+)$/i);
  if (snoozeMatched) {
    const reminderId = snoozeMatched[1];
    const durationMs = parseDurationMs(snoozeMatched[2]);
    if (!durationMs || durationMs <= 0) {
      await channel.send(peerId, { text: "Invalid snooze duration. Example: 10m, 30s, 5000" });
      return;
    }
    const nextRunAt = new Date(Date.now() + durationMs).toISOString();
    const snoozed = reminders.updateNextRunBySession({
      id: reminderId,
      sessionKey,
      nextRunAt,
    });
    await channel.send(peerId, {
      text: snoozed
        ? `Reminder snoozed: ${reminderId}\nnextRunAt: ${nextRunAt}`
        : `Reminder not found: ${reminderId}`,
    });
    return;
  }

  await channel.send(peerId, {
    text: "Usage:\n/reminders list [all] [limit]\n/reminders create in <duration> <message>\n/reminders create every <duration> <message>\n/reminders create at <unixMs|ISO> <message>\n/reminders update <id> in|every|at <time> <message>\n/reminders snooze <id> <duration>\n/reminders cancel <id>",
  });
}
