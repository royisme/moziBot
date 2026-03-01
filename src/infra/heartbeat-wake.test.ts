import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setHeartbeatWakeHandler, requestHeartbeatNow, _resetWake } from "./heartbeat-wake";

describe("HeartbeatWake", () => {
  beforeEach(() => {
    _resetWake();
    vi.useFakeTimers();
  });

  afterEach(() => {
    _resetWake();
    vi.useRealTimers();
  });

  describe("requestHeartbeatNow", () => {
    it("should not throw when no handler is registered", () => {
      expect(() => {
        requestHeartbeatNow({ reason: "test" });
      }).not.toThrow();
    });

    it("should call handler after coalesce delay", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      setHeartbeatWakeHandler(handler);

      requestHeartbeatNow({ reason: "exec-finished", sessionKey: "s1" });

      // Not called yet (within coalesce window)
      expect(handler).not.toHaveBeenCalled();

      // Advance past default coalesce (500ms)
      await vi.advanceTimersByTimeAsync(500);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        reason: "exec-finished",
        sessionKey: "s1",
      });
    });

    it("should coalesce rapid calls into one", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      setHeartbeatWakeHandler(handler);

      requestHeartbeatNow({ reason: "r1", sessionKey: "s1" });
      await vi.advanceTimersByTimeAsync(100);
      requestHeartbeatNow({ reason: "r2", sessionKey: "s1" });
      await vi.advanceTimersByTimeAsync(100);
      requestHeartbeatNow({ reason: "r3", sessionKey: "s1" });

      // Advance past coalesce
      await vi.advanceTimersByTimeAsync(500);

      // Only the last call's reason should be dispatched
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        reason: "r3",
        sessionKey: "s1",
      });
    });

    it("should use custom coalesceMs", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      setHeartbeatWakeHandler(handler);

      requestHeartbeatNow({ reason: "fast", sessionKey: "s1", coalesceMs: 100 });

      await vi.advanceTimersByTimeAsync(100);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("retry on skipped", () => {
    it("should retry when handler returns skipped", async () => {
      const handler = vi.fn().mockResolvedValueOnce("skipped").mockResolvedValueOnce("ok");

      setHeartbeatWakeHandler(handler);

      requestHeartbeatNow({ reason: "retry-test", sessionKey: "s1" });

      // First call after coalesce
      await vi.advanceTimersByTimeAsync(500);
      expect(handler).toHaveBeenCalledTimes(1);

      // Retry after 1500ms
      await vi.advanceTimersByTimeAsync(1500);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("should stop retrying after MAX_RETRIES (2)", async () => {
      const handler = vi.fn().mockResolvedValue("skipped");
      setHeartbeatWakeHandler(handler);

      requestHeartbeatNow({ reason: "stubborn", sessionKey: "s1" });

      // Initial call
      await vi.advanceTimersByTimeAsync(500);
      expect(handler).toHaveBeenCalledTimes(1);

      // Retry 1
      await vi.advanceTimersByTimeAsync(1500);
      expect(handler).toHaveBeenCalledTimes(2);

      // Retry 2
      await vi.advanceTimersByTimeAsync(1500);
      expect(handler).toHaveBeenCalledTimes(3);

      // No more retries
      await vi.advanceTimersByTimeAsync(5000);
      expect(handler).toHaveBeenCalledTimes(3);
    });
  });

  describe("multi-session independence", () => {
    it("should coalesce independently per session", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      setHeartbeatWakeHandler(handler);

      requestHeartbeatNow({ reason: "a", sessionKey: "s-a" });
      requestHeartbeatNow({ reason: "b", sessionKey: "s-b" });

      await vi.advanceTimersByTimeAsync(500);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenCalledWith({ reason: "a", sessionKey: "s-a" });
      expect(handler).toHaveBeenCalledWith({ reason: "b", sessionKey: "s-b" });
    });

    it("should not cancel other session timers on coalesce", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      setHeartbeatWakeHandler(handler);

      requestHeartbeatNow({ reason: "a1", sessionKey: "s-a" });
      await vi.advanceTimersByTimeAsync(200);

      // New request for s-a cancels old timer; s-b starts fresh
      requestHeartbeatNow({ reason: "a2", sessionKey: "s-a" });
      requestHeartbeatNow({ reason: "b1", sessionKey: "s-b" });

      await vi.advanceTimersByTimeAsync(500);

      // Both should fire, s-a with reason "a2" (coalesced)
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenCalledWith({ reason: "a2", sessionKey: "s-a" });
      expect(handler).toHaveBeenCalledWith({ reason: "b1", sessionKey: "s-b" });
    });
  });

  describe("handler error handling", () => {
    it("should not throw when handler rejects", async () => {
      const handler = vi.fn().mockRejectedValue(new Error("boom"));
      setHeartbeatWakeHandler(handler);

      requestHeartbeatNow({ reason: "err", sessionKey: "s1" });

      // Should not throw
      await vi.advanceTimersByTimeAsync(500);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
