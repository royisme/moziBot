import { describe, expect, it, vi } from "vitest";
import { RunLifecycleRegistry } from "./run-lifecycle-registry";

describe("RunLifecycleRegistry", () => {
  it("invokes terminal callback only once for duplicate terminal inputs", () => {
    const onTerminal = vi.fn();
    const registry = new RunLifecycleRegistry({ onTerminal });

    registry.createRun({
      runId: "run-1",
      sessionKey: "s-1",
      agentId: "main",
    });

    const first = registry.finalizeCompleted("run-1", "done");
    const second = registry.finalizeFailed("run-1", new Error("late"));

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal.mock.calls[0]?.[1]).toMatchObject({
      state: "completed",
      partialText: "done",
    });
  });

  it("aborts previous run when creating a new run on same session", () => {
    const onTerminal = vi.fn();
    const registry = new RunLifecycleRegistry({ onTerminal });

    registry.createRun({ runId: "run-1", sessionKey: "s-1", agentId: "main" });
    registry.createRun({ runId: "run-2", sessionKey: "s-1", agentId: "main" });

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal.mock.calls[0]?.[0].runId).toBe("run-1");
    expect(onTerminal.mock.calls[0]?.[1]).toMatchObject({ state: "aborted" });
    expect(registry.getRunBySession("s-1")?.runId).toBe("run-2");
  });

  it("keeps buffer projection when aborted", () => {
    const registry = new RunLifecycleRegistry();
    registry.createRun({ runId: "run-1", sessionKey: "s-1", agentId: "main" });
    registry.appendDelta("run-1", "par");
    registry.appendDelta("run-1", "tial");

    registry.abortRun("run-1", "cancelled");

    const run = registry.getRun("run-1");
    expect(run?.state).toBe("aborted");
    expect(run?.buffer.snapshot()).toBe("partial");
    expect(run?.terminalReason).toBe("cancelled");
  });

  it("ignores late terminal after abort", () => {
    const onTerminal = vi.fn();
    const registry = new RunLifecycleRegistry({ onTerminal });
    registry.createRun({ runId: "run-late", sessionKey: "s-late", agentId: "main" });

    const first = registry.abortRun("run-late", "cancelled");
    const second = registry.finalizeFailed("run-late", new Error("late-fail"));

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal.mock.calls[0]?.[1]).toMatchObject({ state: "aborted", reason: "cancelled" });
  });

  it("marks run as timeout and aborts controller", () => {
    const onTerminal = vi.fn();
    const registry = new RunLifecycleRegistry({ onTerminal });
    const entry = registry.createRun({
      runId: "run-timeout",
      sessionKey: "s-timeout",
      agentId: "main",
    });
    registry.appendDelta("run-timeout", "partial");

    const timedOut = registry.timeoutRun("run-timeout", "subagent-timeout");

    expect(timedOut).toBe(true);
    expect(entry.state).toBe("timeout");
    expect(entry.controller.signal.aborted).toBe(true);
    expect(entry.terminalReason).toBe("subagent-timeout");
    expect(entry.buffer.snapshot()).toBe("partial");
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal.mock.calls[0]?.[1]).toMatchObject({
      state: "timeout",
      reason: "subagent-timeout",
      partialText: "partial",
    });
  });
});
