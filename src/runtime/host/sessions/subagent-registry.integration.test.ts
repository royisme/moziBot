import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { agentEvents } from "../../../infra/agent-events";
import { EnhancedSubAgentRegistry } from "./subagent-registry";

describe("EnhancedSubAgentRegistry", () => {
  let tmpDir: string;
  let registry: EnhancedSubAgentRegistry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-registry-test-"));
    registry = new EnhancedSubAgentRegistry(tmpDir);
  });

  afterEach(() => {
    registry.shutdown();
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
      expect(run?.status).toBe("pending");
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
      expect(data["run-456"].status).toBe("pending");
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
  });

  describe("event handling", () => {
    it("should update status to running on start event", async () => {
      registry.register({
        runId: "run-event-1",
        childKey: "agent:test:subagent:dm:event1",
        parentKey: "parent-event",
        task: "Event test",
        cleanup: "keep",
      });

      agentEvents.emitLifecycle({
        runId: "run-event-1",
        sessionKey: "agent:test:subagent:dm:event1",
        data: { phase: "start", startedAt: Date.now() },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const run = registry.get("run-event-1");
      expect(run?.status).toBe("running");
      expect(run?.startedAt).toBeGreaterThan(0);
    });

    it("should update status to completed on end event", async () => {
      registry.register({
        runId: "run-event-2",
        childKey: "agent:test:subagent:dm:event2",
        parentKey: "parent-event",
        task: "Event test",
        cleanup: "keep",
      });

      agentEvents.emitLifecycle({
        runId: "run-event-2",
        sessionKey: "agent:test:subagent:dm:event2",
        data: { phase: "start", startedAt: Date.now() },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      agentEvents.emitLifecycle({
        runId: "run-event-2",
        sessionKey: "agent:test:subagent:dm:event2",
        data: { phase: "end", endedAt: Date.now() },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const run = registry.get("run-event-2");
      expect(run?.status).toBe("completed");
      expect(run?.endedAt).toBeGreaterThan(0);
    });

    it("should update status to failed on error event", async () => {
      registry.register({
        runId: "run-event-3",
        childKey: "agent:test:subagent:dm:event3",
        parentKey: "parent-event",
        task: "Event test",
        cleanup: "keep",
      });

      agentEvents.emitLifecycle({
        runId: "run-event-3",
        sessionKey: "agent:test:subagent:dm:event3",
        data: { phase: "error", error: "Something went wrong", endedAt: Date.now() },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const run = registry.get("run-event-3");
      expect(run?.status).toBe("failed");
      expect(run?.error).toBe("Something went wrong");
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

      const newRegistry = new EnhancedSubAgentRegistry(restoreTmpDir);
      const run = newRegistry.get("restored-run");

      expect(run).toBeDefined();
      expect(run?.status).toBe("running");
      expect(run?.task).toBe("Restored task");

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
