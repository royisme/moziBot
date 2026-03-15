import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { injectMessageHandler } from "./subagent-announce";
import {
  DetachedRunRegistry,
  createDefaultDeliveryState,
  type DetachedRunRecord,
  type LifecyclePhase,
  type VisibilityPolicy,
  type DeliveryPhaseState,
} from "./subagent-registry";

describe("DetachedRunRegistry - Lifecycle Transitions", () => {
  let tmpDir: string;
  let registry: DetachedRunRegistry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-test-"));
    injectMessageHandler({ handleInternalMessage: async () => {} } as never);
    registry = new DetachedRunRegistry(tmpDir);
  });

  afterEach(() => {
    registry.shutdown();
    injectMessageHandler({ handleInternalMessage: async () => {} } as never);
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {}
  });

  describe("canTransition", () => {
    it("should allow accepted -> started transition", () => {
      expect(registry.canTransition("accepted", "started")).toBe(true);
    });

    it("should allow accepted -> completed transition", () => {
      expect(registry.canTransition("accepted", "completed")).toBe(true);
    });

    it("should allow started -> streaming transition", () => {
      expect(registry.canTransition("started", "streaming")).toBe(true);
    });

    it("should allow started -> completed transition", () => {
      expect(registry.canTransition("started", "completed")).toBe(true);
    });

    it("should allow streaming -> failed transition", () => {
      expect(registry.canTransition("streaming", "failed")).toBe(true);
    });

    it("should allow started -> timeout transition", () => {
      expect(registry.canTransition("started", "timeout")).toBe(true);
    });

    it("should allow started -> aborted transition", () => {
      expect(registry.canTransition("started", "aborted")).toBe(true);
    });

    it("should NOT allow completed -> started transition (terminal)", () => {
      expect(registry.canTransition("completed", "started")).toBe(false);
    });

    it("should NOT allow failed -> completed transition (terminal)", () => {
      expect(registry.canTransition("failed", "completed")).toBe(false);
    });

    it("should NOT allow timeout -> failed transition (terminal)", () => {
      expect(registry.canTransition("timeout", "failed")).toBe(false);
    });

    it("should NOT allow aborted -> streaming transition", () => {
      expect(registry.canTransition("aborted", "streaming")).toBe(false);
    });
  });

  describe("transitionTo", () => {
    it("should transition to started phase", () => {
      registry.register({
        runId: "run-transition-1",
        childKey: "agent:test:subagent:dm:t1",
        parentKey: "parent-1",
        task: "Test task",
        cleanup: "keep",
      });

      const result = registry.transitionTo("run-transition-1", "started");
      expect(result?.status).toBe("started");
      expect(result?.startedAt).toBeGreaterThan(0);
    });

    it("should transition to streaming phase", () => {
      registry.register({
        runId: "run-transition-2",
        childKey: "agent:test:subagent:dm:t2",
        parentKey: "parent-2",
        task: "Test task",
        cleanup: "keep",
      });

      const result = registry.transitionTo("run-transition-2", "streaming");
      expect(result?.status).toBe("streaming");
    });

    it("should transition to completed terminal phase", () => {
      registry.register({
        runId: "run-transition-3",
        childKey: "agent:test:subagent:dm:t3",
        parentKey: "parent-3",
        task: "Test task",
        cleanup: "keep",
      });

      const result = registry.transitionTo("run-transition-3", "completed", {
        result: "Task completed successfully",
      });
      expect(result?.status).toBe("completed");
      expect(result?.result).toBe("Task completed successfully");
      expect(result?.endedAt).toBeGreaterThan(0);
    });

    it("should transition to failed terminal phase", () => {
      registry.register({
        runId: "run-transition-4",
        childKey: "agent:test:subagent:dm:t4",
        parentKey: "parent-4",
        task: "Test task",
        cleanup: "keep",
      });

      const result = registry.transitionTo("run-transition-4", "failed", {
        error: "Something went wrong",
      });
      expect(result?.status).toBe("failed");
      expect(result?.error).toBe("Something went wrong");
    });

    it("should return undefined for invalid transition", () => {
      registry.register({
        runId: "run-transition-5",
        childKey: "agent:test:subagent:dm:t5",
        parentKey: "parent-5",
        task: "Test task",
        cleanup: "keep",
      });

      // First transition to started
      registry.transitionTo("run-transition-5", "started");
      // Then try to transition from completed to something else (invalid)
      const result = registry.transitionTo("run-transition-5", "completed");
      // Actually started -> completed is valid, so let's try invalid
      // started -> started is a no-op, let's create a terminal run first
      const run6 = "run-transition-6";
      registry.register({
        runId: run6,
        childKey: "agent:test:subagent:dm:t6",
        parentKey: "parent-6",
        task: "Test task",
        cleanup: "keep",
      });

      // Transition to completed
      registry.transitionTo(run6, "completed");
      // Try to transition from completed to failed (invalid)
      const invalidResult = registry.transitionTo(run6, "failed");
      expect(invalidResult).toBeUndefined();
    });

    it("should update delivery state for terminal phases", () => {
      registry.register({
        runId: "run-transition-7",
        childKey: "agent:test:subagent:dm:t7",
        parentKey: "parent-7",
        task: "Test task",
        cleanup: "keep",
      });

      registry.transitionTo("run-transition-7", "completed");
      const run = registry.get("run-transition-7");

      expect(run?.terminalDelivery?.status).toBe("pending");
      // pendingDeliveryPhase is set (phase pending delivery)
      expect(run?.pendingDeliveryPhase).toBe("completed");
      // lastDeliveredPhase is "accepted" (auto-delivered on register, no accepted announce)
      expect(run?.lastDeliveredPhase).toBe("accepted");
    });

    it("should return undefined for non-existent run", () => {
      const result = registry.transitionTo("non-existent", "started");
      expect(result).toBeUndefined();
    });
  });

  describe("phase dedupe", () => {
    it("should track delivered phases", () => {
      registry.register({
        runId: "run-dedupe-1",
        childKey: "agent:test:subagent:dm:d1",
        parentKey: "parent-d1",
        task: "Test task",
        cleanup: "keep",
      });

      // accepted is auto-delivered on register (no accepted announce)
      expect(registry.isPhaseDelivered("run-dedupe-1", "accepted")).toBe(true);

      // started is not yet delivered
      expect(registry.isPhaseDelivered("run-dedupe-1", "started")).toBe(false);

      registry.markPhaseDelivered("run-dedupe-1", "started");

      expect(registry.isPhaseDelivered("run-dedupe-1", "started")).toBe(true);
      expect(registry.get("run-dedupe-1")?.lastDeliveredPhase).toBe("started");
    });

    it("should allow re-transition to same phase (idempotent)", () => {
      registry.register({
        runId: "run-dedupe-2",
        childKey: "agent:test:subagent:dm:d2",
        parentKey: "parent-d2",
        task: "Test task",
        cleanup: "keep",
      });

      // First transition
      const result1 = registry.transitionTo("run-dedupe-2", "started");
      expect(result1?.status).toBe("started");

      // Second transition to same phase - should work (idempotent)
      const result2 = registry.transitionTo("run-dedupe-2", "started");
      expect(result2?.status).toBe("started");
    });
  });

  describe("visibility policy", () => {
    it("should default to user_visible", () => {
      registry.register({
        runId: "run-vis-1",
        childKey: "agent:test:subagent:dm:v1",
        parentKey: "parent-v1",
        task: "Test task",
        cleanup: "keep",
      });

      expect(registry.isUserVisible("run-vis-1")).toBe(true);
    });

    it("should allow setting visibility policy", () => {
      registry.register({
        runId: "run-vis-2",
        childKey: "agent:test:subagent:dm:v2",
        parentKey: "parent-v2",
        task: "Test task",
        cleanup: "keep",
        visibilityPolicy: "internal_silent",
      });

      expect(registry.isUserVisible("run-vis-2")).toBe(false);
    });

    it("should allow changing visibility policy", () => {
      registry.register({
        runId: "run-vis-3",
        childKey: "agent:test:subagent:dm:v3",
        parentKey: "parent-v3",
        task: "Test task",
        cleanup: "keep",
      });

      expect(registry.isUserVisible("run-vis-3")).toBe(true);

      registry.setVisibilityPolicy("run-vis-3", "internal_silent");

      expect(registry.isUserVisible("run-vis-3")).toBe(false);
    });

    it("should return false for non-existent run", () => {
      expect(registry.isUserVisible("non-existent")).toBe(false);
    });
  });

  describe("delivery state management", () => {
    it("should initialize delivery state with none status on register", () => {
      registry.register({
        runId: "run-delivery-1",
        childKey: "agent:test:subagent:dm:del1",
        parentKey: "parent-del1",
        task: "Test task",
        cleanup: "keep",
      });

      const run = registry.get("run-delivery-1");
      expect(run?.ackDelivery).toBeDefined();
      // ackDelivery is auto-delivered on register (accepted announce is skipped)
      expect(run?.ackDelivery?.status).toBe("delivered");
      // terminalDelivery starts as "none" - not applicable until terminal
      expect(run?.terminalDelivery).toBeDefined();
      expect(run?.terminalDelivery?.status).toBe("none");
    });

    it("should NOT treat active runs as pending terminal delivery", () => {
      registry.register({
        runId: "run-active-1",
        childKey: "agent:test:subagent:dm:active1",
        parentKey: "parent-active1",
        task: "Active task",
        cleanup: "keep",
      });

      // Active runs should not show up as needing terminal delivery
      const pending = registry.getRunsWithPendingDelivery();
      // Ack is auto-delivered on register, so no pending deliveries
      expect(pending).toHaveLength(0);
    });

    it("should update delivery state", () => {
      registry.register({
        runId: "run-delivery-2",
        childKey: "agent:test:subagent:dm:del2",
        parentKey: "parent-del2",
        task: "Test task",
        cleanup: "keep",
      });

      registry.updateDeliveryState("run-delivery-2", "ack", {
        status: "delivered",
        deliveryEvidenceId: "evidence-123",
        attemptCount: 1,
      });

      const state = registry.getDeliveryState("run-delivery-2", "ack");
      expect(state?.status).toBe("delivered");
      expect(state?.deliveryEvidenceId).toBe("evidence-123");
      expect(state?.deliveredAt).toBeGreaterThan(0);
    });

    it("should track queued timestamp", () => {
      registry.register({
        runId: "run-delivery-3",
        childKey: "agent:test:subagent:dm:del3",
        parentKey: "parent-del3",
        task: "Test task",
        cleanup: "keep",
      });

      registry.updateDeliveryState("run-delivery-3", "terminal", {
        status: "queued",
        attemptCount: 1,
      });

      const state = registry.getDeliveryState("run-delivery-3", "terminal");
      expect(state?.status).toBe("queued");
      expect(state?.queuedAt).toBeGreaterThan(0);
    });

    it("should return undefined for non-existent run", () => {
      const state = registry.getDeliveryState("non-existent", "ack");
      expect(state).toBeUndefined();
    });
  });

  describe("serialization and restore", () => {
    it("should serialize runs to JSON", () => {
      registry.register({
        runId: "run-serial-1",
        childKey: "agent:test:subagent:dm:s1",
        parentKey: "parent-s1",
        task: "Test task",
        cleanup: "keep",
        visibilityPolicy: "user_visible",
      });

      registry.transitionTo("run-serial-1", "started");

      const serialized = registry.serialize();
      expect(serialized["run-serial-1"]).toBeDefined();
      expect(serialized["run-serial-1"]?.status).toBe("started");
      expect(serialized["run-serial-1"]?.visibilityPolicy).toBe("user_visible");
    });

    it("should restore delivery state from serialized data", () => {
      // Create first registry with data
      registry.register({
        runId: "run-restore-1",
        childKey: "agent:test:subagent:dm:r1",
        parentKey: "parent-r1",
        task: "Test task",
        cleanup: "keep",
      });

      registry.updateDeliveryState("run-restore-1", "ack", {
        status: "delivered",
        deliveryEvidenceId: "evidence-456",
        attemptCount: 2,
      });

      // Get serialized data
      const serialized = registry.serialize();

      // Create new registry and restore
      const newTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-test-"));
      const newRegistry = new DetachedRunRegistry(newTmpDir);
      newRegistry.restoreFromSerialized(serialized);

      const restored = newRegistry.get("run-restore-1");
      expect(restored?.ackDelivery?.status).toBe("delivered");
      expect(restored?.ackDelivery?.deliveryEvidenceId).toBe("evidence-456");

      newRegistry.shutdown();
      fs.rmSync(newTmpDir, { recursive: true });
    });

    it("should get runs with pending delivery", () => {
      registry.register({
        runId: "run-pending-1",
        childKey: "agent:test:subagent:dm:p1",
        parentKey: "parent-p1",
        task: "Task 1",
        cleanup: "keep",
      });

      registry.register({
        runId: "run-pending-2",
        childKey: "agent:test:subagent:dm:p2",
        parentKey: "parent-p2",
        task: "Task 2",
        cleanup: "keep",
      });

      // Both runs have ack auto-delivered on register, so no pending deliveries
      const pending = registry.getRunsWithPendingDelivery();
      expect(pending).toHaveLength(0);
    });

    it("should get undelivered terminal runs", () => {
      registry.register({
        runId: "run-terminal-1",
        childKey: "agent:test:subagent:dm:tterm1",
        parentKey: "parent-tterm1",
        task: "Task 1",
        cleanup: "keep",
      });

      registry.register({
        runId: "run-terminal-2",
        childKey: "agent:test:subagent:dm:tterm2",
        parentKey: "parent-tterm2",
        task: "Task 2",
        cleanup: "keep",
      });

      // Transition to terminal but don't mark delivered
      registry.transitionTo("run-terminal-1", "completed", { result: "done" });

      // Mark the other as delivered
      registry.transitionTo("run-terminal-2", "completed", { result: "done" });
      registry.updateDeliveryState("run-terminal-2", "terminal", { status: "delivered" });

      const undelivered = registry.getUndeliveredTerminalRuns();
      expect(undelivered).toHaveLength(1);
      expect(undelivered[0]?.runId).toBe("run-terminal-1");
    });
  });

  describe("terminal bookkeeping", () => {
    it("should set terminal with lifecycle transition", async () => {
      registry.register({
        runId: "run-term-1",
        childKey: "agent:test:subagent:dm:term1",
        parentKey: "parent-term1",
        task: "Test task",
        cleanup: "keep",
      });

      const result = await registry.setTerminal({
        runId: "run-term-1",
        status: "completed",
        result: "Final result",
      });

      expect(result?.status).toBe("completed");
      expect(result?.result).toBe("Final result");
      expect(result?.terminalDelivery?.status).toBe("delivered");
    });

    it("should set terminal with error", async () => {
      registry.register({
        runId: "run-term-2",
        childKey: "agent:test:subagent:dm:term2",
        parentKey: "parent-term2",
        task: "Test task",
        cleanup: "keep",
      });

      const result = await registry.setTerminal({
        runId: "run-term-2",
        status: "failed",
        error: "Error occurred",
      });

      expect(result?.status).toBe("failed");
      expect(result?.error).toBe("Error occurred");
    });

    it("should track pending delivery phase after terminal (before actual delivery)", async () => {
      registry.register({
        runId: "run-term-3",
        childKey: "agent:test:subagent:dm:term3",
        parentKey: "parent-term3",
        task: "Test task",
        cleanup: "keep",
      });

      await registry.setTerminal({
        runId: "run-term-3",
        status: "completed",
      });

      const run = registry.get("run-term-3");
      expect(run?.pendingDeliveryPhase).toBeUndefined();
      expect(run?.lastDeliveredPhase).toBe("completed");
      expect(run?.terminalDelivery?.status).toBe("delivered");
    });
  });
});

describe("createDefaultDeliveryState", () => {
  it("should create default state with none status", () => {
    const state = createDefaultDeliveryState();
    expect(state.status).toBe("none");
    expect(state.attemptCount).toBe(0);
    expect(state.deliveryEvidenceId).toBeUndefined();
    expect(state.queuedAt).toBeUndefined();
    expect(state.deliveredAt).toBeUndefined();
    expect(state.lastError).toBeUndefined();
  });
});

// === Task 04: Parent Turn Suppression Guard Tests ===

describe("DetachedRunRegistry - Parent Turn Suppression Guard", () => {
  let tmpDir: string;
  let registry: DetachedRunRegistry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suppression-guard-test-"));
    registry = new DetachedRunRegistry(tmpDir);
  });

  afterEach(() => {
    registry.shutdown();
    injectMessageHandler({ handleInternalMessage: async () => {} } as never);
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {}
  });

  describe("getPendingUserVisibleAck", () => {
    it("should return hasPendingUserVisible=false when no runs exist", () => {
      const result = registry.getPendingUserVisibleAck("parent-key-1");
      expect(result.hasPendingUserVisible).toBe(false);
      expect(result.pendingRunIds).toEqual([]);
    });

    it("should return hasPendingUserVisible=false when user-visible run has auto-delivered ack", () => {
      // Register a run with user_visible policy (default)
      // Ack is auto-delivered on register (accepted announce is skipped)
      registry.register({
        runId: "run-1",
        kind: "subagent",
        childKey: "child-1",
        parentKey: "parent-key-1",
        task: "test task",
        cleanup: "keep",
        visibilityPolicy: "user_visible",
      });

      const result = registry.getPendingUserVisibleAck("parent-key-1");
      expect(result.hasPendingUserVisible).toBe(false);
    });

    it("should return hasPendingUserVisible=false for internal_silent runs", () => {
      registry.register({
        runId: "run-1",
        kind: "subagent",
        childKey: "child-1",
        parentKey: "parent-key-1",
        task: "test task",
        cleanup: "keep",
        visibilityPolicy: "internal_silent",
      });

      const result = registry.getPendingUserVisibleAck("parent-key-1");
      expect(result.hasPendingUserVisible).toBe(false);
    });

    it("should return hasPendingUserVisible=false when ack is delivered for a non-terminal run", () => {
      registry.register({
        runId: "run-1",
        kind: "subagent",
        childKey: "child-1",
        parentKey: "parent-key-1",
        task: "test task",
        cleanup: "keep",
        visibilityPolicy: "user_visible",
      });

      registry.updateDeliveryState("run-1", "ack", {
        status: "delivered",
        deliveredAt: Date.now(),
      });

      const result = registry.getPendingUserVisibleAck("parent-key-1");
      expect(result.hasPendingUserVisible).toBe(false);
    });

    it("should keep terminal runs pending until terminal delivery is complete", () => {
      registry.register({
        runId: "run-1",
        kind: "subagent",
        childKey: "child-1",
        parentKey: "parent-key-1",
        task: "test task",
        cleanup: "keep",
        visibilityPolicy: "user_visible",
      });

      registry.transitionTo("run-1", "completed", { result: "done" });

      const result = registry.getPendingUserVisibleAck("parent-key-1");
      expect(result.hasPendingUserVisible).toBe(true);
      expect(result.pendingRunIds).toContain("run-1");
    });

    it("should filter by parent key correctly", () => {
      // Create runs for two different parents
      registry.register({
        runId: "run-1",
        kind: "subagent",
        childKey: "child-1",
        parentKey: "parent-key-1",
        task: "task 1",
        cleanup: "keep",
        visibilityPolicy: "user_visible",
      });

      registry.register({
        runId: "run-2",
        kind: "subagent",
        childKey: "child-2",
        parentKey: "parent-key-2",
        task: "task 2",
        cleanup: "keep",
        visibilityPolicy: "user_visible",
      });

      // Ack is auto-delivered, so no pending for non-terminal runs
      const result1 = registry.getPendingUserVisibleAck("parent-key-1");
      expect(result1.hasPendingUserVisible).toBe(false);

      // But terminal runs with undelivered terminal delivery are still pending
      registry.transitionTo("run-1", "completed", { result: "done" });
      const result1After = registry.getPendingUserVisibleAck("parent-key-1");
      expect(result1After.hasPendingUserVisible).toBe(true);
      expect(result1After.pendingRunIds).toEqual(["run-1"]);

      // parent-key-2 still has no pending
      const result2 = registry.getPendingUserVisibleAck("parent-key-2");
      expect(result2.hasPendingUserVisible).toBe(false);
    });

    it("should track multiple pending runs for same parent when terminal", () => {
      registry.register({
        runId: "run-1",
        kind: "subagent",
        childKey: "child-1",
        parentKey: "parent-key-1",
        task: "task 1",
        cleanup: "keep",
        visibilityPolicy: "user_visible",
      });

      registry.register({
        runId: "run-2",
        kind: "subagent",
        childKey: "child-2",
        parentKey: "parent-key-1",
        task: "task 2",
        cleanup: "keep",
        visibilityPolicy: "user_visible",
      });

      // Transition both to terminal with undelivered terminal delivery
      registry.transitionTo("run-1", "completed", { result: "done" });
      registry.transitionTo("run-2", "failed", { error: "err" });

      const result = registry.getPendingUserVisibleAck("parent-key-1");
      expect(result.hasPendingUserVisible).toBe(true);
      expect(result.pendingRunIds).toHaveLength(2);
    });
  });

  describe("needsAckDelivery and isAckDelivered", () => {
    it("should report needsAckDelivery=false after register (auto-delivered)", () => {
      registry.register({
        runId: "run-1",
        kind: "subagent",
        childKey: "child-1",
        parentKey: "parent-key-1",
        task: "test task",
        cleanup: "keep",
        visibilityPolicy: "user_visible",
      });

      // Ack is auto-delivered on register (accepted announce is skipped)
      expect(registry.needsAckDelivery("run-1")).toBe(false);
      expect(registry.isAckDelivered("run-1")).toBe(true);
    });

    it("should report isAckDelivered correctly after delivery", () => {
      registry.register({
        runId: "run-1",
        kind: "subagent",
        childKey: "child-1",
        parentKey: "parent-key-1",
        task: "test task",
        cleanup: "keep",
        visibilityPolicy: "user_visible",
      });

      registry.updateDeliveryState("run-1", "ack", {
        status: "delivered",
        deliveredAt: Date.now(),
      });

      expect(registry.needsAckDelivery("run-1")).toBe(false);
      expect(registry.isAckDelivered("run-1")).toBe(true);
    });

    it("should not need ack for internal_silent runs", () => {
      registry.register({
        runId: "run-1",
        kind: "subagent",
        childKey: "child-1",
        parentKey: "parent-key-1",
        task: "test task",
        cleanup: "keep",
        visibilityPolicy: "internal_silent",
      });

      expect(registry.needsAckDelivery("run-1")).toBe(false);
    });

    it("should return false for non-existent run", () => {
      expect(registry.needsAckDelivery("non-existent")).toBe(false);
      expect(registry.isAckDelivered("non-existent")).toBe(false);
    });
  });
});

// === Task 05: Recovery and Regression Validation Tests ===

describe("DetachedRunRegistry - Recovery and Regression Validation", () => {
  let tmpDir: string;
  let registry: DetachedRunRegistry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-test-"));
    registry = new DetachedRunRegistry(tmpDir);
  });

  afterEach(() => {
    registry.shutdown();
    injectMessageHandler({ handleInternalMessage: async () => {} } as never);
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {}
  });

  describe("validateNoBlackHoleTasks - Regression Tests", () => {
    it("should pass validation when terminal user-visible task has delivered status", () => {
      registry.register({
        runId: "run-bh-1",
        childKey: "agent:test:subagent:dm:bh1",
        parentKey: "parent-bh1",
        task: "Task 1",
        cleanup: "keep",
        visibilityPolicy: "user_visible",
      });

      registry.transitionTo("run-bh-1", "completed", { result: "done" });
      registry.updateDeliveryState("run-bh-1", "terminal", { status: "delivered" });

      const validation = registry.validateNoBlackHoleTasks();
      expect(validation.isValid).toBe(true);
      expect(validation.violations).toHaveLength(0);
    });

    it("should pass validation when terminal user-visible task has pending delivery", () => {
      registry.register({
        runId: "run-bh-2",
        childKey: "agent:test:subagent:dm:bh2",
        parentKey: "parent-bh2",
        task: "Task 2",
        cleanup: "keep",
        visibilityPolicy: "user_visible",
      });

      registry.transitionTo("run-bh-2", "failed", { error: "some error" });
      // terminalDelivery is set to pending by transitionTo

      const validation = registry.validateNoBlackHoleTasks();
      // pending is acceptable - it's queued for retry
      expect(validation.isValid).toBe(true);
      expect(validation.violations).toHaveLength(0);
    });

    it("should pass validation for internal_silent terminal tasks regardless of delivery", () => {
      registry.register({
        runId: "run-bh-3",
        childKey: "agent:test:subagent:dm:bh3",
        parentKey: "parent-bh3",
        task: "Task 3",
        cleanup: "keep",
        visibilityPolicy: "internal_silent",
      });

      registry.transitionTo("run-bh-3", "completed", { result: "done" });
      // Don't update delivery state - internal tasks don't need user delivery

      const validation = registry.validateNoBlackHoleTasks();
      expect(validation.isValid).toBe(true);
    });

    it("should fail validation when terminal user-visible task has no delivery state", () => {
      // Create a terminal run without proper delivery state (simulating a bug)
      // Manually set status to terminal without going through proper transition
      (registry as unknown as { runs: Map<string, unknown> }).runs.set("run-bh-4", {
        runId: "run-bh-4",
        childKey: "agent:test:subagent:dm:bh4",
        parentKey: "parent-bh4",
        task: "Task 4",
        cleanup: "keep",
        status: "completed",
        visibilityPolicy: "user_visible",
        // Missing terminalDelivery - this is the bug we're checking for
      } as never);

      const validation = registry.validateNoBlackHoleTasks();
      expect(validation.isValid).toBe(false);
      expect(validation.violations).toHaveLength(1);
      expect(validation.violations[0]?.runId).toBe("run-bh-4");
      expect(validation.violations[0]?.issue).toContain("no delivery state");
    });

    it("should detect multiple violations across multiple runs", () => {
      // Create two runs with violations
      (registry as unknown as { runs: Map<string, unknown> }).runs.set("run-bh-5", {
        runId: "run-bh-5",
        childKey: "agent:test:subagent:dm:bh5",
        parentKey: "parent-bh5",
        task: "Task 5",
        cleanup: "keep",
        status: "failed",
        visibilityPolicy: "user_visible",
      } as never);

      (registry as unknown as { runs: Map<string, unknown> }).runs.set("run-bh-6", {
        runId: "run-bh-6",
        childKey: "agent:test:subagent:dm:bh6",
        parentKey: "parent-bh6",
        task: "Task 6",
        cleanup: "keep",
        status: "completed",
        visibilityPolicy: "user_visible",
      } as never);

      const validation = registry.validateNoBlackHoleTasks();
      expect(validation.isValid).toBe(false);
      expect(validation.violations).toHaveLength(2);
    });

    it("should NOT flag active (non-terminal) runs as violations", () => {
      registry.register({
        runId: "run-active-1",
        childKey: "agent:test:subagent:dm:active1",
        parentKey: "parent-active1",
        task: "Active task",
        cleanup: "keep",
        visibilityPolicy: "user_visible",
      });

      // Run is in "accepted" or "started" state - not terminal
      // Should not be flagged as black hole
      const validation = registry.validateNoBlackHoleTasks();
      expect(validation.isValid).toBe(true);
      expect(validation.violations).toHaveLength(0);
    });
  });

  describe("getRunsNeedingReplay - Startup Diagnostics", () => {
    it("should return empty when no runs need replay", () => {
      const result = registry.getRunsNeedingReplay();
      expect(result.pendingAck).toHaveLength(0);
      expect(result.undeliveredTerminal).toHaveLength(0);
    });

    it("should not identify runs with auto-delivered ack as needing replay", () => {
      registry.register({
        runId: "run-replay-1",
        childKey: "agent:test:subagent:dm:r1",
        parentKey: "parent-r1",
        task: "Task 1",
        cleanup: "keep",
      });

      // Ack is auto-delivered on register, so no pending ack
      const result = registry.getRunsNeedingReplay();
      expect(result.pendingAck).toHaveLength(0);
    });

    it("should identify undelivered terminal runs", () => {
      registry.register({
        runId: "run-replay-2",
        childKey: "agent:test:subagent:dm:r2",
        parentKey: "parent-r2",
        task: "Task 2",
        cleanup: "keep",
      });

      registry.transitionTo("run-replay-2", "completed", { result: "done" });
      // Don't mark as delivered - it should show up as needing replay

      const result = registry.getRunsNeedingReplay();
      expect(result.undeliveredTerminal).toHaveLength(1);
      expect(result.undeliveredTerminal[0]?.runId).toBe("run-replay-2");
    });

    it("should not include delivered terminal runs in undelivered list", () => {
      registry.register({
        runId: "run-replay-3",
        childKey: "agent:test:subagent:dm:r3",
        parentKey: "parent-r3",
        task: "Task 3",
        cleanup: "keep",
      });

      registry.transitionTo("run-replay-3", "completed", { result: "done" });
      registry.updateDeliveryState("run-replay-3", "terminal", { status: "delivered" });

      const result = registry.getRunsNeedingReplay();
      expect(result.undeliveredTerminal).toHaveLength(0);
    });
  });

  describe("Persistence boundary tests", () => {
    it("should preserve delivery state across serialization", () => {
      registry.register({
        runId: "run-persist-1",
        childKey: "agent:test:subagent:dm:persist1",
        parentKey: "parent-persist1",
        task: "Task 1",
        cleanup: "keep",
        visibilityPolicy: "user_visible",
      });

      registry.updateDeliveryState("run-persist-1", "ack", {
        status: "delivered",
        deliveryEvidenceId: "evidence-abc",
        attemptCount: 3,
      });

      // Serialize and verify
      const serialized = registry.serialize();
      expect(serialized["run-persist-1"]?.ackDelivery?.status).toBe("delivered");
      expect(serialized["run-persist-1"]?.ackDelivery?.deliveryEvidenceId).toBe("evidence-abc");

      // Create new registry and restore
      const newTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "persist-test-"));
      const newRegistry = new DetachedRunRegistry(newTmpDir);
      newRegistry.restoreFromSerialized(serialized);

      // Verify delivery state survived
      const restored = newRegistry.get("run-persist-1");
      expect(restored?.ackDelivery?.status).toBe("delivered");
      expect(restored?.ackDelivery?.deliveryEvidenceId).toBe("evidence-abc");

      // Validation should pass after restore
      const validation = newRegistry.validateNoBlackHoleTasks();
      expect(validation.isValid).toBe(true);

      newRegistry.shutdown();
      fs.rmSync(newTmpDir, { recursive: true });
    });

    it("should preserve lastDeliveredPhase across serialization", () => {
      registry.register({
        runId: "run-persist-2",
        childKey: "agent:test:subagent:dm:persist2",
        parentKey: "parent-persist2",
        task: "Task 2",
        cleanup: "keep",
      });

      registry.markPhaseDelivered("run-persist-2", "accepted");
      registry.markPhaseDelivered("run-persist-2", "started");

      const serialized = registry.serialize();
      expect(serialized["run-persist-2"]?.lastDeliveredPhase).toBe("started");

      // Create new registry and restore
      const newTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-persist-test-"));
      const newRegistry = new DetachedRunRegistry(newTmpDir);
      newRegistry.restoreFromSerialized(serialized);

      const restored = newRegistry.get("run-persist-2");
      expect(restored?.lastDeliveredPhase).toBe("started");

      newRegistry.shutdown();
      fs.rmSync(newTmpDir, { recursive: true });
    });
  });

  describe("reconcileOrphanedRuns ack retry", () => {
    const registerPendingAckRun = (
      runId: string,
      visibilityPolicy: VisibilityPolicy = "user_visible",
    ) => {
      registry.restoreFromSerialized({
        ...registry.serialize(),
        [runId]: {
          runId,
          kind: "subagent",
          childKey: `child-${runId}`,
          parentKey: "parent-ack-reconcile",
          task: `task-${runId}`,
          cleanup: "keep",
          status: "accepted",
          createdAt: Date.now(),
          visibilityPolicy,
          ackDelivery: {
            ...createDefaultDeliveryState(),
            status: "pending",
            attemptCount: 0,
          },
          terminalDelivery: createDefaultDeliveryState(),
          announcedPhases: {
            accepted: false,
            started: false,
            streaming: false,
            completed: false,
            failed: false,
            aborted: false,
            timeout: false,
          },
        } as DetachedRunRecord,
      });
    };

    it("retries pending ack and marks it delivered on success", async () => {
      const handleInternalMessage = vi.fn(async () => {});
      injectMessageHandler({ handleInternalMessage } as never);
      registerPendingAckRun("run-ack-1");

      const result = await registry.reconcileOrphanedRuns({
        parentKey: "parent-ack-reconcile",
        isRunActive: () => true,
      });

      const run = registry.get("run-ack-1");
      expect(result.retriedAck).toBe(1);
      expect(result.retriedAckRunIds).toEqual(["run-ack-1"]);
      expect(run?.ackDelivery?.status).toBe("delivered");
      expect(run?.ackDelivery?.attemptCount).toBe(1);
      expect(run?.ackDelivery?.lastError).toBeUndefined();
      expect(handleInternalMessage).toHaveBeenCalledTimes(1);
      expect(handleInternalMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "parent-ack-reconcile",
          source: "detached-run-announce",
          metadata: expect.objectContaining({
            detachedRunId: "run-ack-1",
            detachedStatus: "accepted",
          }),
        }),
      );
    });

    it("continues retrying remaining pending ack deliveries when one throws", async () => {
      registerPendingAckRun("run-ack-1");
      registerPendingAckRun("run-ack-2");
      registerPendingAckRun("run-ack-3");

      const deliveryOrder: string[] = [];
      const triggerPhaseAnnounce = vi.spyOn(registry, "triggerPhaseAnnounce");
      triggerPhaseAnnounce.mockImplementation(async (run, phase) => {
        deliveryOrder.push(run.runId);
        if (run.runId === "run-ack-2") {
          throw new Error("ack delivery exploded");
        }
        return DetachedRunRegistry.prototype.triggerPhaseAnnounce.call(registry, run, phase);
      });

      const result = await registry.reconcileOrphanedRuns({
        parentKey: "parent-ack-reconcile",
        isRunActive: () => true,
      });

      expect(deliveryOrder).toEqual(["run-ack-1", "run-ack-2", "run-ack-3"]);
      expect(result.retriedAck).toBe(2);
      expect(result.retriedAckRunIds).toEqual(["run-ack-1", "run-ack-3"]);
      expect(registry.get("run-ack-1")?.ackDelivery?.status).toBe("delivered");
      expect(registry.get("run-ack-3")?.ackDelivery?.status).toBe("delivered");
      expect(registry.get("run-ack-2")?.ackDelivery).toEqual(
        expect.objectContaining({
          status: "pending",
          attemptCount: 1,
          lastError: "ack delivery exploded",
        }),
      );
    });

    it("keeps repeated accepted announcements idempotent after successful delivery", async () => {
      const handleInternalMessage = vi.fn(async () => {});
      injectMessageHandler({ handleInternalMessage } as never);
      registerPendingAckRun("run-ack-idempotent");

      const run = registry.get("run-ack-idempotent");
      expect(run).toBeDefined();

      await registry.triggerPhaseAnnounce(run as DetachedRunRecord, "accepted");
      const firstDeliveredAt = registry.get("run-ack-idempotent")?.ackDelivery?.deliveredAt;

      await registry.triggerPhaseAnnounce(
        registry.get("run-ack-idempotent") as DetachedRunRecord,
        "accepted",
      );
      const finalRun = registry.get("run-ack-idempotent");

      expect(handleInternalMessage).toHaveBeenCalledTimes(1);
      expect(finalRun?.ackDelivery?.status).toBe("delivered");
      expect(finalRun?.ackDelivery?.deliveredAt).toBe(firstDeliveredAt);
      expect(finalRun?.announcedPhases?.accepted).toBe(true);
    });
  });
});
