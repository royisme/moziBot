import { describe, expect, it, beforeEach } from "vitest";
import { ContinuationRegistry } from "./continuation";

describe("ContinuationRegistry", () => {
  let registry: ContinuationRegistry;

  beforeEach(() => {
    registry = new ContinuationRegistry();
  });

  it("schedules and consumes continuations for a session", () => {
    const sessionKey = "test-session-1";
    const request = {
      prompt: "Continue with step 2",
      reason: "Multi-step task",
    };

    registry.schedule(sessionKey, request);

    expect(registry.hasPending(sessionKey)).toBe(true);

    const consumed = registry.consume(sessionKey);
    expect(consumed).toHaveLength(1);
    expect(consumed[0].prompt).toBe("Continue with step 2");
    expect(consumed[0].reason).toBe("Multi-step task");

    expect(registry.hasPending(sessionKey)).toBe(false);
  });

  it("schedules multiple continuations for same session", () => {
    const sessionKey = "test-session-2";

    registry.schedule(sessionKey, { prompt: "Step 1" });
    registry.schedule(sessionKey, { prompt: "Step 2", delayMs: 1000 });
    registry.schedule(sessionKey, { prompt: "Step 3", context: { foo: "bar" } });

    const consumed = registry.consume(sessionKey);
    expect(consumed).toHaveLength(3);
    expect(consumed[0].prompt).toBe("Step 1");
    expect(consumed[1].prompt).toBe("Step 2");
    expect(consumed[1].delayMs).toBe(1000);
    expect(consumed[2].prompt).toBe("Step 3");
    expect(consumed[2].context).toEqual({ foo: "bar" });
  });

  it("keeps sessions isolated", () => {
    registry.schedule("session-a", { prompt: "Task A" });
    registry.schedule("session-b", { prompt: "Task B" });

    expect(registry.hasPending("session-a")).toBe(true);
    expect(registry.hasPending("session-b")).toBe(true);

    const consumedA = registry.consume("session-a");
    expect(consumedA).toHaveLength(1);
    expect(consumedA[0].prompt).toBe("Task A");

    expect(registry.hasPending("session-a")).toBe(false);
    expect(registry.hasPending("session-b")).toBe(true);
  });

  it("returns empty array when no pending continuations", () => {
    expect(registry.consume("nonexistent")).toEqual([]);
    expect(registry.hasPending("nonexistent")).toBe(false);
  });

  it("clears continuations for a specific session", () => {
    registry.schedule("session-x", { prompt: "Task X" });
    registry.schedule("session-y", { prompt: "Task Y" });

    registry.clear("session-x");

    expect(registry.hasPending("session-x")).toBe(false);
    expect(registry.hasPending("session-y")).toBe(true);
  });

  it("clears all continuations", () => {
    registry.schedule("session-1", { prompt: "Task 1" });
    registry.schedule("session-2", { prompt: "Task 2" });
    registry.schedule("session-3", { prompt: "Task 3" });

    registry.clearAll();

    expect(registry.hasPending("session-1")).toBe(false);
    expect(registry.hasPending("session-2")).toBe(false);
    expect(registry.hasPending("session-3")).toBe(false);
  });
});
