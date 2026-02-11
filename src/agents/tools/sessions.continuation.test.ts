import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { continuationRegistry } from "../../runtime/core/continuation";
import { scheduleContinuation, type SessionToolsContext } from "./sessions";

describe("scheduleContinuation tool", () => {
  const mockSessionManager = {
    get: () => null,
    list: () => [],
    setStatus: async () => {},
    getOrCreate: async () => ({}),
  } as unknown as SessionToolsContext["sessionManager"];

  const mockSubAgentRegistry = {
    listByParent: () => [],
  } as unknown as SessionToolsContext["subAgentRegistry"];

  beforeEach(() => {
    continuationRegistry.clearAll();
  });

  afterEach(() => {
    continuationRegistry.clearAll();
  });

  it("schedules a continuation request", async () => {
    const ctx: SessionToolsContext = {
      sessionManager: mockSessionManager,
      subAgentRegistry: mockSubAgentRegistry,
      currentSessionKey: "test-session-1",
    };

    const result = await scheduleContinuation(ctx, {
      prompt: "Continue with the next step",
      reason: "Multi-step workflow",
    });

    expect(result.scheduled).toBe(true);
    expect(result.message).toContain("immediately");

    const pending = continuationRegistry.consume("test-session-1");
    expect(pending).toHaveLength(1);
    expect(pending[0].prompt).toBe("Continue with the next step");
    expect(pending[0].reason).toBe("Multi-step workflow");
  });

  it("schedules a continuation with delay", async () => {
    const ctx: SessionToolsContext = {
      sessionManager: mockSessionManager,
      subAgentRegistry: mockSubAgentRegistry,
      currentSessionKey: "test-session-2",
    };

    const result = await scheduleContinuation(ctx, {
      prompt: "Check status after delay",
      delayMs: 5000,
    });

    expect(result.scheduled).toBe(true);
    expect(result.message).toContain("5000ms delay");

    const pending = continuationRegistry.consume("test-session-2");
    expect(pending).toHaveLength(1);
    expect(pending[0].delayMs).toBe(5000);
  });

  it("schedules a continuation with context", async () => {
    const ctx: SessionToolsContext = {
      sessionManager: mockSessionManager,
      subAgentRegistry: mockSubAgentRegistry,
      currentSessionKey: "test-session-3",
    };

    const result = await scheduleContinuation(ctx, {
      prompt: "Process next item",
      context: { itemIndex: 5, total: 10 },
    });

    expect(result.scheduled).toBe(true);

    const pending = continuationRegistry.consume("test-session-3");
    expect(pending).toHaveLength(1);
    expect(pending[0].context).toEqual({ itemIndex: 5, total: 10 });
  });

  it("schedules multiple continuations in sequence", async () => {
    const ctx: SessionToolsContext = {
      sessionManager: mockSessionManager,
      subAgentRegistry: mockSubAgentRegistry,
      currentSessionKey: "test-session-4",
    };

    await scheduleContinuation(ctx, { prompt: "Step 1" });
    await scheduleContinuation(ctx, { prompt: "Step 2" });
    await scheduleContinuation(ctx, { prompt: "Step 3" });

    const pending = continuationRegistry.consume("test-session-4");
    expect(pending).toHaveLength(3);
    expect(pending.map((p) => p.prompt)).toEqual(["Step 1", "Step 2", "Step 3"]);
  });

  it("rejects delayed heartbeat-style continuation loops", async () => {
    const ctx: SessionToolsContext = {
      sessionManager: mockSessionManager,
      subAgentRegistry: mockSubAgentRegistry,
      currentSessionKey: "test-session-5",
    };

    const result = await scheduleContinuation(ctx, {
      prompt: "2 minutes later do heartbeat check",
      delayMs: 120000,
      reason: "heartbeat periodic polling",
    });

    expect(result.scheduled).toBe(false);
    expect(result.message).toContain("HEARTBEAT.md");
    expect(continuationRegistry.consume("test-session-5")).toEqual([]);
  });
});
