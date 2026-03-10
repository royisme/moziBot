import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { agentEvents } from "../../../infra/agent-events";
import { injectMessageHandler } from "./subagent-announce";
import { DetachedRunRegistry } from "./subagent-registry";

describe("DetachedRunRegistry", () => {
  let tmpDir: string;
  let registry: DetachedRunRegistry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-registry-test-"));
    registry = new DetachedRunRegistry(tmpDir);
  });

  afterEach(() => {
    registry.shutdown();
    injectMessageHandler({ handleInternalMessage: async () => {} } as never);
    agentEvents.removeAllListeners();
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {}
  });

  describe("register", () => {
    it("should register a new subagent run with pending status", () => {
      registry.register({
        runId: "run-123",
        childKey: "agent:test:subagent:dm:abc",
        parentKey: "agent:test:telegram:dm:456",
        task: "Analyze something",
        label: "Test task",
        cleanup: "keep",
      });

      const run = registry.get("run-123");
      expect(run).toBeDefined();
      expect(run?.kind).toBe("subagent");
      expect(run?.status).toBe("accepted");
      expect(run?.task).toBe("Analyze something");
      expect(run?.label).toBe("Test task");
      expect(run?.createdAt).toBeGreaterThan(0);
    });

    it("should persist to disk", () => {
      registry.register({
        runId: "run-456",
        childKey: "agent:test:subagent:dm:def",
        parentKey: "agent:test:telegram:dm:789",
        task: "Test task",
        cleanup: "keep",
      });

      const filePath = path.join(tmpDir, "subagent-runs.json");
      expect(fs.existsSync(filePath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      expect(data["run-456"]).toBeDefined();
      expect(data["run-456"].status).toBe("accepted");
    });
  });

  describe("listByParent", () => {
    it("should list runs by parent key", () => {
      registry.register({
        runId: "run-1",
        childKey: "agent:test:subagent:dm:a",
        parentKey: "parent-1",
        task: "Task 1",
        cleanup: "keep",
      });
      registry.register({
        runId: "run-2",
        childKey: "agent:test:subagent:dm:b",
        parentKey: "parent-1",
        task: "Task 2",
        cleanup: "keep",
      });
      registry.register({
        runId: "run-3",
        childKey: "agent:test:subagent:dm:c",
        parentKey: "parent-2",
        task: "Task 3",
        cleanup: "keep",
      });

      const runs = registry.listByParent("parent-1");
      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.runId).toSorted()).toEqual(["run-1", "run-2"]);
    });

    it("should list only non-terminal runs as active", () => {
      registry.register({
        runId: "run-active",
        childKey: "agent:test:subagent:dm:active",
        parentKey: "parent-active",
        task: "Active task",
        cleanup: "keep",
        status: "started",
      });
      registry.register({
        runId: "run-done",
        childKey: "agent:test:subagent:dm:done",
        parentKey: "parent-active",
        task: "Done task",
        cleanup: "keep",
        status: "completed",
      });

      const runs = registry.listActiveByParent("parent-active");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.runId).toBe("run-active");
    });
  });

  describe("event handling", () => {
    it("should update status to started when markStarted is called", () => {
      registry.register({
        runId: "run-event-1",
        childKey: "agent:test:subagent:dm:event1",
        parentKey: "parent-event",
        task: "Event test",
        cleanup: "keep",
      });

      registry.markStarted("run-event-1");

      const run = registry.get("run-event-1");
      expect(run?.status).toBe("started");
      expect(run?.startedAt).toBeGreaterThan(0);
    });

    it("should update status to completed when setTerminal is called", async () => {
      registry.register({
        runId: "run-event-2",
        childKey: "agent:test:subagent:dm:event2",
        parentKey: "parent-event",
        task: "Event test",
        cleanup: "keep",
      });

      registry.markStarted("run-event-2");
      await registry.setTerminal({
        runId: "run-event-2",
        status: "completed",
        endedAt: Date.now(),
      });

      const run = registry.get("run-event-2");
      expect(run?.status).toBe("completed");
      expect(run?.endedAt).toBeGreaterThan(0);
    });

    it("should update status to failed when setTerminal is called with an error", async () => {
      registry.register({
        runId: "run-event-3",
        childKey: "agent:test:subagent:dm:event3",
        parentKey: "parent-event",
        task: "Event test",
        cleanup: "keep",
      });

      await registry.setTerminal({
        runId: "run-event-3",
        status: "failed",
        error: "Something went wrong",
        endedAt: Date.now(),
      });

      const run = registry.get("run-event-3");
      expect(run?.status).toBe("failed");
      expect(run?.error).toBe("Something went wrong");
    });

    it("announces aborted runs instead of silently swallowing them", async () => {
      const handleInternalMessage = vi.fn(async () => {});
      injectMessageHandler({ handleInternalMessage } as never);
      registry.register({
        runId: "run-event-aborted",
        childKey: "agent:test:subagent:dm:event-aborted",
        parentKey: "parent-event",
        task: "Event aborted",
        cleanup: "keep",
      });

      await registry.setTerminal({
        runId: "run-event-aborted",
        status: "aborted",
        error: "manual-abort",
        endedAt: Date.now(),
      });

      const run = registry.get("run-event-aborted");
      expect(run?.status).toBe("aborted");
      expect(run?.announced).toBe(true);
      expect(handleInternalMessage).toHaveBeenCalledTimes(1);
      expect(handleInternalMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "parent-event",
          metadata: expect.objectContaining({
            detachedRunId: "run-event-aborted",
            detachedStatus: "aborted",
          }),
        }),
      );
    });

    it("rolls back terminal state when persistence fails", async () => {
      registry.register({
        runId: "run-event-persist-fail",
        childKey: "agent:test:subagent:dm:event-persist-fail",
        parentKey: "parent-event",
        task: "Event persist fail",
        cleanup: "keep",
      });

      const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
        throw new Error("disk-full");
      });

      await expect(
        registry.setTerminal({
          runId: "run-event-persist-fail",
          status: "failed",
          error: "Something went wrong",
          endedAt: Date.now(),
        }),
      ).rejects.toThrow("disk-full");

      writeSpy.mockRestore();
      const run = registry.get("run-event-persist-fail");
      expect(run?.status).toBe("accepted");
      expect(run?.error).toBeUndefined();
      expect(run?.endedAt).toBeUndefined();
      expect(run?.announced).toBeUndefined();
    });
  });

  describe("restore", () => {
    it("should restore runs from disk on initialization", () => {
      const restoreTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-restore-test-"));
      const filePath = path.join(restoreTmpDir, "subagent-runs.json");
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          "restored-run": {
            runId: "restored-run",
            childKey: "agent:test:subagent:dm:restored",
            parentKey: "parent-restored",
            task: "Restored task",
            cleanup: "keep",
            status: "running",
            createdAt: Date.now() - 1000,
            startedAt: Date.now() - 500,
          },
        }),
      );

      const newRegistry = new DetachedRunRegistry(restoreTmpDir);
      const run = newRegistry.get("restored-run");

      expect(run).toBeDefined();
      expect(run?.status).toBe("running");
      expect(run?.task).toBe("Restored task");

      newRegistry.shutdown();
      try {
        fs.rmSync(restoreTmpDir, { recursive: true });
      } catch {}
    });

    it("reconciles restored non-terminal runs and announces them", async () => {
      const restoreTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-reconcile-test-"));
      const filePath = path.join(restoreTmpDir, "subagent-runs.json");
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          "restored-run": {
            runId: "restored-run",
            childKey: "agent:test:subagent:dm:restored",
            parentKey: "parent-restored",
            task: "Restored task",
            cleanup: "keep",
            status: "started",
            createdAt: Date.now() - 1000,
            startedAt: Date.now() - 500,
          },
        }),
      );

      const handleInternalMessage = vi.fn(async () => {});
      injectMessageHandler({ handleInternalMessage } as never);

      const newRegistry = new DetachedRunRegistry(restoreTmpDir);
      await newRegistry.reconcileOrphanedRuns();
      const run = newRegistry.get("restored-run");

      expect(run).toBeDefined();
      expect(run?.status).toBe("failed");
      expect(run?.error).toBe("Host restarted while run was in progress");
      expect(run?.announced).toBe(true);
      expect(run?.endedAt).toBeGreaterThan(0);
      expect(handleInternalMessage).toHaveBeenCalledTimes(1);
      expect(handleInternalMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "parent-restored",
          source: "detached-run-announce",
          metadata: expect.objectContaining({
            taskKind: "subagent",
            detachedRunId: "restored-run",
            detachedChildKey: "agent:test:subagent:dm:restored",
            detachedStatus: "failed",
          }),
        }),
      );

      newRegistry.shutdown();
      try {
        fs.rmSync(restoreTmpDir, { recursive: true });
      } catch {}
    });

    it("retries restored terminal runs whose announcement previously failed", async () => {
      const restoreTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-reannounce-test-"));
      const filePath = path.join(restoreTmpDir, "subagent-runs.json");
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          "restored-run": {
            runId: "restored-run",
            childKey: "agent:test:subagent:dm:restored",
            parentKey: "parent-restored",
            task: "Restored task",
            cleanup: "keep",
            status: "completed",
            createdAt: Date.now() - 1000,
            startedAt: Date.now() - 800,
            endedAt: Date.now() - 500,
            result: "done",
            announced: false,
          },
        }),
      );

      const handleInternalMessage = vi.fn(async () => {});
      injectMessageHandler({ handleInternalMessage } as never);

      const newRegistry = new DetachedRunRegistry(restoreTmpDir);
      await newRegistry.reconcileOrphanedRuns();
      const run = newRegistry.get("restored-run");

      expect(run).toBeDefined();
      expect(run?.status).toBe("completed");
      expect(run?.announced).toBe(true);
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      expect(data["restored-run"].announced).toBe(true);
      expect(handleInternalMessage).toHaveBeenCalledTimes(1);
      expect(handleInternalMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "parent-restored",
          source: "detached-run-announce",
          metadata: expect.objectContaining({
            taskKind: "subagent",
            detachedRunId: "restored-run",
            detachedChildKey: "agent:test:subagent:dm:restored",
            detachedStatus: "completed",
          }),
        }),
      );

      newRegistry.shutdown();
      try {
        fs.rmSync(restoreTmpDir, { recursive: true });
      } catch {}
    });

    it("reconciles restored delete-cleanup runs and removes them", async () => {
      const restoreTmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "subagent-reconcile-delete-test-"),
      );
      const filePath = path.join(restoreTmpDir, "subagent-runs.json");
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          "restored-run": {
            runId: "restored-run",
            childKey: "agent:test:subagent:dm:restored",
            parentKey: "parent-restored",
            task: "Restored task",
            cleanup: "delete",
            status: "streaming",
            createdAt: Date.now() - 1000,
            startedAt: Date.now() - 500,
          },
        }),
      );

      const handleInternalMessage = vi.fn(async () => {});
      injectMessageHandler({ handleInternalMessage } as never);

      const newRegistry = new DetachedRunRegistry(restoreTmpDir);
      await newRegistry.reconcileOrphanedRuns();

      expect(newRegistry.get("restored-run")).toBeUndefined();
      expect(handleInternalMessage).toHaveBeenCalledTimes(1);

      newRegistry.shutdown();
      try {
        fs.rmSync(restoreTmpDir, { recursive: true });
      } catch {}
    });
  });

  describe("getByChildKey", () => {
    it("should find run by child key", () => {
      registry.register({
        runId: "run-child-key",
        childKey: "agent:test:subagent:dm:findme",
        parentKey: "parent-test",
        task: "Find me task",
        cleanup: "keep",
      });

      const run = registry.getByChildKey("agent:test:subagent:dm:findme");
      expect(run).toBeDefined();
      expect(run?.runId).toBe("run-child-key");
    });

    it("should return undefined for unknown child key", () => {
      const run = registry.getByChildKey("agent:test:subagent:dm:unknown");
      expect(run).toBeUndefined();
    });
  });
});
