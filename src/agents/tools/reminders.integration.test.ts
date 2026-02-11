import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SessionToolsContext } from "./sessions";
import { SessionManager } from "../../runtime/host/sessions/manager";
import { SubAgentRegistry } from "../../runtime/host/sessions/spawn";
import { closeDb, initDb } from "../../storage/db";
import {
  reminderCancel,
  reminderCreate,
  reminderList,
  reminderSnooze,
  reminderUpdate,
} from "./reminders";

const TEST_DB = "data/test-reminder-tools.db";

function cleanupTestDb() {
  if (existsSync(TEST_DB)) {
    unlinkSync(TEST_DB);
  }
  if (existsSync(`${TEST_DB}-wal`)) {
    unlinkSync(`${TEST_DB}-wal`);
  }
  if (existsSync(`${TEST_DB}-shm`)) {
    unlinkSync(`${TEST_DB}-shm`);
  }
}

describe("Reminder tools", () => {
  let sessionManager: SessionManager;
  let subAgentRegistry: SubAgentRegistry;
  let ctx: SessionToolsContext;

  beforeEach(async () => {
    cleanupTestDb();
    initDb(TEST_DB);

    sessionManager = new SessionManager();
    subAgentRegistry = new SubAgentRegistry();
    const currentSessionKey = "agent:mozi:telegram:dm:user1";
    await sessionManager.getOrCreate(currentSessionKey, {
      channel: "telegram",
      peerId: "user1",
      peerType: "dm",
      agentId: "mozi",
    });

    ctx = {
      sessionManager,
      subAgentRegistry,
      currentSessionKey,
    };
  });

  afterEach(() => {
    closeDb();
    cleanupTestDb();
  });

  test("create/list/cancel reminder", async () => {
    const created = await reminderCreate(ctx, {
      message: "ping",
      schedule: {
        kind: "every",
        everyMs: 60_000,
      },
    });
    expect(created.created).toBe(true);

    const list = await reminderList(ctx, {});
    expect(list.reminders.length).toBe(1);
    expect(list.reminders[0].id).toBe(created.reminderId);

    const cancelled = await reminderCancel(ctx, {
      reminderId: created.reminderId,
    });
    expect(cancelled.cancelled).toBe(true);

    const activeOnly = await reminderList(ctx, {});
    expect(activeOnly.reminders.length).toBe(0);
  });

  test("update and snooze reminder", async () => {
    const created = await reminderCreate(ctx, {
      message: "first",
      schedule: {
        kind: "every",
        everyMs: 60_000,
      },
    });

    const updated = await reminderUpdate(ctx, {
      reminderId: created.reminderId,
      message: "updated",
      schedule: {
        kind: "every",
        everyMs: 120_000,
      },
    });
    expect(updated.updated).toBe(true);

    const snoozed = await reminderSnooze(ctx, {
      reminderId: created.reminderId,
      delayMs: 30_000,
    });
    expect(snoozed.snoozed).toBe(true);

    const listed = await reminderList(ctx, {});
    expect(listed.reminders.length).toBe(1);
    expect(listed.reminders[0].message).toBe("updated");
    expect(listed.reminders[0].nextRunAt).toBe(snoozed.nextRunAt);
  });

  test("cancel is scoped to current session", async () => {
    const created = await reminderCreate(ctx, {
      message: "scoped",
      schedule: {
        kind: "every",
        everyMs: 60_000,
      },
    });

    const otherSession = "agent:mozi:telegram:dm:someone-else";
    await sessionManager.getOrCreate(otherSession, {
      channel: "telegram",
      peerId: "someone-else",
      peerType: "dm",
      agentId: "mozi",
    });
    const otherCtx: SessionToolsContext = {
      sessionManager,
      subAgentRegistry,
      currentSessionKey: otherSession,
    };

    const cancelledFromOther = await reminderCancel(otherCtx, {
      reminderId: created.reminderId,
    });
    expect(cancelledFromOther.cancelled).toBe(false);

    const cancelledFromOwner = await reminderCancel(ctx, {
      reminderId: created.reminderId,
    });
    expect(cancelledFromOwner.cancelled).toBe(true);
  });
});
