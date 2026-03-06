import { beforeEach, describe, expect, it, vi } from "vitest";
import { reminders } from "../../../storage/db";
import { ReminderRunner } from "./runner";

vi.mock("../../../storage/db", () => ({
  reminders: {
    listDue: vi.fn(),
    markFired: vi.fn(),
  },
}));

describe("ReminderRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function dueReminder() {
    return {
      id: "rem-1",
      session_key: "agent:mozi:telegram:dm:user1",
      channel_id: "telegram",
      peer_id: "user1",
      peer_type: "dm",
      message: "Ping",
      schedule_kind: "every",
      schedule_json: JSON.stringify({ kind: "every", everyMs: 60_000, anchorMs: Date.now() }),
      enabled: 1,
      next_run_at: new Date(Date.now() - 1000).toISOString(),
      last_run_at: null,
      cancelled_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  it("enqueues due reminder into runtime kernel", async () => {
    const enqueueInbound = vi.fn(async () => ({
      accepted: true,
      deduplicated: false,
      queueItemId: "q-1",
      sessionKey: "agent:mozi:telegram:dm:user1",
    }));
    vi.mocked(reminders.listDue).mockReturnValue([dueReminder()] as never);
    vi.mocked(reminders.markFired).mockReturnValue(true);

    const runner = new ReminderRunner({ enqueueInbound } as never, 1000, 10);
    await runner.tick();

    expect(reminders.listDue).toHaveBeenCalled();
    expect(reminders.markFired).toHaveBeenCalled();
    expect(enqueueInbound).toHaveBeenCalledTimes(1);
    expect(enqueueInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        inbound: expect.objectContaining({
          raw: expect.objectContaining({ source: "reminder" }),
        }),
      }),
    );
  });

  it("runs reminder as agent job when job runtime is available", async () => {
    const enqueueInbound = vi.fn();
    const run = vi.fn(async () => ({
      context: {
        jobId: "q-1",
        sessionKey: "agent:mozi:telegram:dm:user1",
        agentId: "mozi",
        source: "reminder",
        kind: "scheduled",
      },
      snapshot: { id: "q-1", status: "completed", ts: Date.now() },
      finalText: "Ping",
    }));
    vi.mocked(reminders.listDue).mockReturnValue([dueReminder()] as never);
    vi.mocked(reminders.markFired).mockReturnValue(true);

    const create = vi.fn((input) => ({ ...input, status: "queued" }));
    const runner = new ReminderRunner({ enqueueInbound } as never, 1000, 10, {
      jobRunner: { run } as never,
      jobRegistry: { create } as never,
    });
    await runner.tick();

    expect(run).toHaveBeenCalledTimes(1);
    expect(enqueueInbound).not.toHaveBeenCalled();
  });
});
