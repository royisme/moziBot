import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  injectDirectDeliveryDeps,
  deliverDirectMessage,
  deliverGuaranteedLifecycleNotification,
  buildSimpleAckMessage,
} from "./async-task-delivery";

describe("async-task-delivery", () => {
  const mockChannel = {
    send: vi.fn().mockResolvedValue("msg-123"),
    getCapabilities: vi.fn().mockReturnValue({}),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Inject mock dependencies
    injectDirectDeliveryDeps({
      getChannel: (sessionKey: string) => {
        if (sessionKey === "valid-session") {
          return mockChannel;
        }
        return undefined;
      },
      getPeerId: (sessionKey: string) => {
        if (sessionKey === "valid-session") {
          return "peer-123";
        }
        return undefined;
      },
      getRoute: (sessionKey: string) => {
        if (sessionKey === "valid-session") {
          return { threadId: "thread-7", replyToId: "reply-9" };
        }
        return undefined;
      },
    });
  });

  afterEach(() => {
    // Reset deps
    injectDirectDeliveryDeps({
      getChannel: () => undefined,
      getPeerId: () => undefined,
      getRoute: () => undefined,
    });
  });

  describe("deliverDirectMessage", () => {
    it("delivers message directly via channel when channel is available", async () => {
      const messageId = await deliverDirectMessage({
        sessionKey: "valid-session",
        text: "Test message",
      });

      expect(messageId).toBe("msg-123");
      expect(mockChannel.send).toHaveBeenCalledWith("peer-123", {
        text: "Test message",
        threadId: "thread-7",
        replyToId: "reply-9",
      });
    });

    it("omits thread and reply routing when route is unavailable", async () => {
      const messageId = await deliverDirectMessage({
        sessionKey: "no-peer-session",
        text: "Test message",
      });

      expect(messageId).toBeUndefined();
    });

    it("returns undefined when channel is not found", async () => {
      const messageId = await deliverDirectMessage({
        sessionKey: "invalid-session",
        text: "Test message",
      });

      expect(messageId).toBeUndefined();
      expect(mockChannel.send).not.toHaveBeenCalled();
    });

    it("returns undefined when peerId is not found", async () => {
      const messageId = await deliverDirectMessage({
        sessionKey: "no-peer-session",
        text: "Test message",
      });

      expect(messageId).toBeUndefined();
    });

    it("returns undefined when channel send throws", async () => {
      mockChannel.send.mockRejectedValueOnce(new Error("send failed"));

      const messageId = await deliverDirectMessage({
        sessionKey: "valid-session",
        text: "Test message",
      });

      expect(messageId).toBeUndefined();
    });
  });

  describe("buildSimpleAckMessage", () => {
    it("builds accepted message correctly", () => {
      const msg = buildSimpleAckMessage({ taskLabel: "TestTask", phase: "accepted" });
      expect(msg).toBe('Background task "TestTask" has been accepted.');
    });

    it("builds started message correctly", () => {
      const msg = buildSimpleAckMessage({ taskLabel: "TestTask", phase: "started" });
      expect(msg).toBe('Working on "TestTask"...');
    });

    it("builds completed message with duration", () => {
      const msg = buildSimpleAckMessage({
        taskLabel: "TestTask",
        phase: "completed",
        duration: "5m30s",
      });
      expect(msg).toBe('Background task "TestTask" completed in 5m30s. Use /tasks for details.');
    });

    it("builds completed message without duration", () => {
      const msg = buildSimpleAckMessage({ taskLabel: "TestTask", phase: "completed" });
      expect(msg).toBe('Background task "TestTask" completed. Use /tasks for details.');
    });

    it("builds failed message with error", () => {
      const msg = buildSimpleAckMessage({
        taskLabel: "TestTask",
        phase: "failed",
        error: "Something went wrong",
      });
      expect(msg).toBe('Background task "TestTask" failed: Something went wrong. Use /tasks for details.');
    });

    it("builds failed message without error", () => {
      const msg = buildSimpleAckMessage({ taskLabel: "TestTask", phase: "failed" });
      expect(msg).toBe('Background task "TestTask" failed. Use /tasks for details.');
    });

    it("builds timeout message with duration", () => {
      const msg = buildSimpleAckMessage({
        taskLabel: "TestTask",
        phase: "timeout",
        duration: "10m",
      });
      expect(msg).toBe('Background task "TestTask" timed out after 10m. Use /tasks for details.');
    });

    it("builds aborted message with error", () => {
      const msg = buildSimpleAckMessage({
        taskLabel: "TestTask",
        phase: "aborted",
        error: "User cancelled",
      });
      expect(msg).toBe('Background task "TestTask" was cancelled: User cancelled. Use /tasks for details.');
    });
  });

  describe("deliverGuaranteedLifecycleNotification", () => {
    it("delivers directly when channel is available", async () => {
      const result = await deliverGuaranteedLifecycleNotification({
        sessionKey: "valid-session",
        taskLabel: "TestTask",
        phase: "accepted",
        fallbackAnnounce: vi.fn().mockResolvedValue(true),
      });

      expect(result.delivered).toBe(true);
      expect(result.messageId).toBe("msg-123");
      expect(result.usedFallback).toBe(false);
      expect(mockChannel.send).toHaveBeenCalled();
    });

    it("falls back to summarization when direct delivery fails", async () => {
      mockChannel.send.mockResolvedValueOnce(undefined);

      const fallbackFn = vi.fn().mockResolvedValue(true);
      const result = await deliverGuaranteedLifecycleNotification({
        sessionKey: "valid-session",
        taskLabel: "TestTask",
        phase: "completed",
        fallbackAnnounce: fallbackFn,
      });

      expect(result.delivered).toBe(true);
      expect(result.usedFallback).toBe(true);
      expect(fallbackFn).toHaveBeenCalled();
    });

    it("falls back to summarization when channel not found", async () => {
      const fallbackFn = vi.fn().mockResolvedValue(true);
      const result = await deliverGuaranteedLifecycleNotification({
        sessionKey: "invalid-session",
        taskLabel: "TestTask",
        phase: "completed",
        fallbackAnnounce: fallbackFn,
      });

      expect(result.delivered).toBe(true);
      expect(result.usedFallback).toBe(true);
      expect(fallbackFn).toHaveBeenCalled();
    });

    it("returns delivered=false when both direct and fallback fail", async () => {
      mockChannel.send.mockResolvedValueOnce(undefined);
      const fallbackFn = vi.fn().mockResolvedValue(false);

      const result = await deliverGuaranteedLifecycleNotification({
        sessionKey: "valid-session",
        taskLabel: "TestTask",
        phase: "failed",
        fallbackAnnounce: fallbackFn,
      });

      expect(result.delivered).toBe(false);
      expect(result.usedFallback).toBe(true);
    });
  });
});
