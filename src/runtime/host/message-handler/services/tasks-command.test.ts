import { describe, expect, it, vi } from "vitest";
import { handleTasksCommand } from "./tasks-command";
import type { TaskRunView } from "./tasks-control-plane";

function getPayload(send: ReturnType<typeof vi.fn>) {
  expect(send).toHaveBeenCalled();
  return send.mock.calls[0]?.[1];
}

function makeRun(overrides: Partial<TaskRunView> = {}): TaskRunView {
  return {
    runId: "run-1",
    parentKey: "parent-1",
    childKey: "child-1",
    task: "Test task",
    status: "started",
    kind: "subagent",
    createdAt: Date.now(),
    live: false,
    ...overrides,
  };
}

describe("handleTasksCommand", () => {
  it("renders empty state when no tasks exist", async () => {
    const send = vi.fn(async () => undefined);
    await handleTasksCommand({
      sessionKey: "parent-1",
      args: "",
      peerId: "peer-1",
      channel: { send },
      controlPlane: {
        listForParent: vi.fn(() => []),
      } as never,
    });

    expect(send).toHaveBeenCalledWith("peer-1", { text: "No detached tasks for this session." });
  });

  it("renders buttons for listed tasks", async () => {
    const send = vi.fn(async () => undefined);
    await handleTasksCommand({
      sessionKey: "parent-1",
      args: "",
      peerId: "peer-1",
      channel: { send },
      controlPlane: {
        listForParent: vi.fn(() => [
          makeRun({ runId: "run-a", label: "alpha", live: true, runtimeState: "started" }),
        ]),
      } as never,
    });

    const payload = getPayload(send) as {
      text: string;
      buttons: Array<Array<{ callbackData: string }>>;
    };
    expect(payload.text).toContain("Tasks (1)");
    expect(payload.text).toContain("run-a");
    expect(payload.buttons[0]?.[0]?.callbackData).toBe("/tasks status run-a");
    expect(payload.buttons[0]?.[1]?.callbackData).toBe("/tasks stop run-a");
  });

  it("renders run detail for status subcommand", async () => {
    const send = vi.fn(async () => undefined);
    await handleTasksCommand({
      sessionKey: "parent-1",
      args: "status run-a",
      peerId: "peer-1",
      channel: { send },
      controlPlane: {
        getDetail: vi.fn(() => makeRun({ runId: "run-a", label: "alpha", error: "boom" })),
      } as never,
    });

    const payload = getPayload(send) as {
      text: string;
      buttons: Array<Array<{ callbackData: string }>>;
    };
    expect(payload.text).toContain("Run: run-a");
    expect(payload.text).toContain("Task: alpha");
    expect(payload.text).toContain("Error: boom");
    expect(payload.buttons[0]?.[0]?.callbackData).toBe("/tasks");
  });

  it("stops a run and refreshes the list", async () => {
    const send = vi.fn(async () => undefined);
    const stop = vi.fn(async () => ({ ok: true, code: "stopped", message: "Stopped run run-a." }));
    const listForParent = vi.fn(() => [makeRun({ runId: "run-a", status: "aborted" })]);

    await handleTasksCommand({
      sessionKey: "parent-1",
      args: "stop run-a",
      peerId: "peer-1",
      channel: { send },
      controlPlane: {
        stop,
        listForParent,
      } as never,
    });

    expect(stop).toHaveBeenCalledWith("run-a", "parent-1", "user");
    const payload = getPayload(send) as { text: string };
    expect(payload.text).toContain("Stopped run run-a.");
    expect(payload.text).toContain("Tasks (1)");
  });

  it("runs reconcile and refreshes the list", async () => {
    const send = vi.fn(async () => undefined);
    const reconcile = vi.fn(async () => ({
      ok: true,
      retried: 0,
      reconciled: 1,
      runIds: ["run-a"],
      message: "Reconciled 1 run(s) and retried 0 pending delivery run(s).",
    }));

    await handleTasksCommand({
      sessionKey: "parent-1",
      args: "reconcile",
      peerId: "peer-1",
      channel: { send },
      controlPlane: {
        reconcile,
        listForParent: vi.fn(() => [makeRun({ runId: "run-a", status: "aborted" })]),
      } as never,
    });

    expect(reconcile).toHaveBeenCalledWith("parent-1", "user");
    const payload = getPayload(send) as { text: string };
    expect(payload.text).toContain("Reconciled 1 run(s)");
    expect(payload.text).toContain("run-a");
  });
});
