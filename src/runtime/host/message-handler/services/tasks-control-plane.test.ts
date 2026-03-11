import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DetachedRunRegistry } from "../../sessions/subagent-registry";
import { RunLifecycleRegistry } from "./run-lifecycle-registry";
import { TasksControlPlane } from "./tasks-control-plane";

describe("TasksControlPlane", () => {
  let tmpDir: string;
  let detachedRunRegistry: DetachedRunRegistry;
  let runLifecycleRegistry: RunLifecycleRegistry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-control-plane-"));
    detachedRunRegistry = new DetachedRunRegistry(tmpDir);
    runLifecycleRegistry = new RunLifecycleRegistry();
  });

  afterEach(() => {
    detachedRunRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shows live runtime state in list output", () => {
    detachedRunRegistry.register({
      runId: "run-live",
      childKey: "child-live",
      parentKey: "parent-1",
      task: "Do live work",
      cleanup: "keep",
      label: "live",
    });
    runLifecycleRegistry.createRun({
      runId: "run-live",
      sessionKey: "child-live",
      agentId: "mozi",
    });
    runLifecycleRegistry.markStarted("run-live");

    const controlPlane = new TasksControlPlane(detachedRunRegistry, runLifecycleRegistry);
    const [run] = controlPlane.listForParent("parent-1");

    expect(run?.runId).toBe("run-live");
    expect(run?.live).toBe(true);
    expect(run?.runtimeState).toBe("started");
  });

  it("stops a live run through the runtime lifecycle registry", async () => {
    detachedRunRegistry.register({
      runId: "run-stop-live",
      childKey: "child-stop-live",
      parentKey: "parent-1",
      task: "Stop me live",
      cleanup: "keep",
    });
    runLifecycleRegistry.createRun({
      runId: "run-stop-live",
      sessionKey: "child-stop-live",
      agentId: "mozi",
    });

    const controlPlane = new TasksControlPlane(detachedRunRegistry, runLifecycleRegistry);
    const result = await controlPlane.stop("run-stop-live", "parent-1", "user");
    const updated = detachedRunRegistry.get("run-stop-live");

    expect(result.ok).toBe(true);
    expect(result.code).toBe("stopped");
    expect(result.message).toContain("Stopped run run-stop-live");
    expect(updated?.abortRequestedBy).toBe("user");
    expect(updated?.abortRequestedAt).toBeTypeOf("number");
    expect(runLifecycleRegistry.getRun("run-stop-live")?.state).toBe("aborted");
  });

  it("falls back to terminal reconciliation for orphaned runs", async () => {
    detachedRunRegistry.register({
      runId: "run-orphan",
      childKey: "child-orphan",
      parentKey: "parent-1",
      task: "Orphaned task",
      cleanup: "keep",
      status: "started",
      startedAt: Date.now(),
    });

    const controlPlane = new TasksControlPlane(detachedRunRegistry, runLifecycleRegistry);
    const result = await controlPlane.stop("run-orphan", "parent-1", "user");
    const updated = detachedRunRegistry.get("run-orphan");

    expect(result.ok).toBe(true);
    expect(result.code).toBe("stopped");
    expect(result.message).toContain("terminal reconciliation");
    expect(updated?.status).toBe("aborted");
    expect(updated?.staleDetectedAt).toBeTypeOf("number");
    expect(updated?.error).toContain("Stopped by user (orphaned run)");
  });

  it("rejects stop for runs from another parent session", async () => {
    detachedRunRegistry.register({
      runId: "run-foreign",
      childKey: "child-foreign",
      parentKey: "parent-a",
      task: "Foreign task",
      cleanup: "keep",
    });

    const controlPlane = new TasksControlPlane(detachedRunRegistry, runLifecycleRegistry);
    const result = await controlPlane.stop("run-foreign", "parent-b", "user");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("forbidden");
    expect(result.message).toContain("does not belong to this session");
  });

  it("reconciles orphaned runs for a parent session", async () => {
    detachedRunRegistry.register({
      runId: "run-reconcile",
      childKey: "child-reconcile",
      parentKey: "parent-1",
      task: "Reconcile me",
      cleanup: "keep",
      status: "started",
      startedAt: Date.now(),
    });

    const controlPlane = new TasksControlPlane(detachedRunRegistry, runLifecycleRegistry);
    const result = await controlPlane.reconcile("parent-1", "user");
    const updated = detachedRunRegistry.get("run-reconcile");

    expect(result.ok).toBe(true);
    expect(result.reconciled).toBe(1);
    expect(result.runIds).toContain("run-reconcile");
    expect(updated?.status).toBe("aborted");
    expect(updated?.abortRequestedBy).toBe("user");
    expect(updated?.staleDetectedAt).toBeTypeOf("number");
  });
});
