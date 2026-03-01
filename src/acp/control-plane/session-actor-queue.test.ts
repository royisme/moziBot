import { describe, expect, it, beforeEach } from "vitest";
import { SessionActorQueue } from "./session-actor-queue";

describe("SessionActorQueue", () => {
  let queue: SessionActorQueue;

  beforeEach(() => {
    queue = new SessionActorQueue();
  });

  describe("run", () => {
    it("should execute operation immediately when queue is empty", async () => {
      const result = await queue.run("session1", async () => {
        return "result";
      });
      expect(result).toBe("result");
    });

    it("should queue operations for same session", async () => {
      const executionOrder: number[] = [];

      const promise1 = queue.run("session1", async () => {
        executionOrder.push(1);
        await new Promise((r) => setTimeout(r, 10));
        executionOrder.push(2);
      });

      const promise2 = queue.run("session1", async () => {
        executionOrder.push(3);
        await new Promise((r) => setTimeout(r, 10));
        executionOrder.push(4);
      });

      await Promise.all([promise1, promise2]);

      // Operations should execute sequentially
      expect(executionOrder).toEqual([1, 2, 3, 4]);
    });

    it("should allow concurrent operations for different sessions", async () => {
      const executionOrder: string[] = [];

      const promise1 = queue.run("session1", async () => {
        executionOrder.push("s1-start");
        await new Promise((r) => setTimeout(r, 20));
        executionOrder.push("s1-end");
      });

      const promise2 = queue.run("session2", async () => {
        executionOrder.push("s2-start");
        await new Promise((r) => setTimeout(r, 10));
        executionOrder.push("s2-end");
      });

      await Promise.all([promise1, promise2]);

      // Different sessions can run concurrently
      expect(executionOrder).toContain("s1-start");
      expect(executionOrder).toContain("s2-start");
    });

    it("should continue queue after operation failure", async () => {
      const executionOrder: number[] = [];

      await queue
        .run("session1", async () => {
          executionOrder.push(1);
          throw new Error("test error");
        })
        .catch(() => {});

      await queue.run("session1", async () => {
        executionOrder.push(2);
      });

      expect(executionOrder).toEqual([1, 2]);
    });

    it("should track pending count", async () => {
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });

      void queue.run("session1", async () => {
        await firstPromise;
      });

      expect(queue.getPendingCountForSession("session1")).toBe(1);

      resolveFirst!();
      await firstPromise;

      // Wait for cleanup
      await new Promise((r) => setTimeout(r, 10));
      expect(queue.getPendingCountForSession("session1")).toBe(0);
    });
  });

  describe("getTotalPendingCount", () => {
    it("should return 0 when no pending operations", () => {
      expect(queue.getTotalPendingCount()).toBe(0);
    });

    it("should return total pending across all sessions", async () => {
      let resolve1: () => void;
      let resolve2: () => void;

      const promise1 = new Promise<void>((resolve) => {
        resolve1 = resolve;
      });
      const promise2 = new Promise<void>((resolve) => {
        resolve2 = resolve;
      });

      void queue.run("session1", async () => {
        await promise1;
      });

      void queue.run("session2", async () => {
        await promise2;
      });

      expect(queue.getTotalPendingCount()).toBe(2);

      resolve1!();
      resolve2!();
      await Promise.resolve();
    });
  });

  describe("getPendingCountForSession", () => {
    it("should return 0 for session with no pending operations", () => {
      expect(queue.getPendingCountForSession("nonexistent")).toBe(0);
    });

    it("should return pending count for specific session", async () => {
      const promise = new Promise<void>((_resolve) => {
        // never resolves - intentionally left pending
      });

      void queue.run("session1", async () => {
        await promise;
      });

      void queue.run("session1", async () => {});

      expect(queue.getPendingCountForSession("session1")).toBe(2);
    });
  });

  describe("getTailMapForTesting", () => {
    it("should return the internal tail map", () => {
      const tailMap = queue.getTailMapForTesting();
      expect(tailMap).toBeInstanceOf(Map);
    });
  });

  describe("queue cleanup", () => {
    it("should clean up tail after all operations complete", async () => {
      await queue.run("session1", async () => {});
      await queue.run("session1", async () => {});

      // Wait for cleanup
      await new Promise((r) => setTimeout(r, 10));

      const tailMap = queue.getTailMapForTesting();
      expect(tailMap.has("session1")).toBe(false);
    });

    it("should keep tail while operations are pending", async () => {
      let resolve: (() => void) | undefined;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });

      void queue.run("session1", async () => {
        await promise;
      });

      const tailMap = queue.getTailMapForTesting();
      expect(tailMap.has("session1")).toBe(true);

      resolve!();
      await promise;
    });
  });
});
