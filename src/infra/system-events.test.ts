import { describe, it, expect, beforeEach } from "vitest";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  drainSystemEvents,
  hasSystemEvents,
  _resetAllQueues,
} from "./system-events";

describe("SystemEventQueue", () => {
  beforeEach(() => {
    _resetAllQueues();
  });

  describe("enqueueSystemEvent", () => {
    it("should enqueue an event and make it visible via peek", () => {
      const result = enqueueSystemEvent("test event", { sessionKey: "s1" });
      expect(result).toBe(true);

      const events = peekSystemEventEntries("s1");
      expect(events).toHaveLength(1);
      expect(events[0].text).toBe("test event");
      expect(events[0].ts).toBeGreaterThan(0);
    });

    it("should enqueue multiple events in order", () => {
      enqueueSystemEvent("first", { sessionKey: "s1" });
      enqueueSystemEvent("second", { sessionKey: "s1" });
      enqueueSystemEvent("third", { sessionKey: "s1" });

      const events = peekSystemEventEntries("s1");
      expect(events).toHaveLength(3);
      expect(events.map((e) => e.text)).toEqual(["first", "second", "third"]);
    });
  });

  describe("contextKey dedup", () => {
    it("should reject duplicate contextKey when consecutive", () => {
      const r1 = enqueueSystemEvent("exec done", {
        sessionKey: "s1",
        contextKey: "exec:run-1",
      });
      const r2 = enqueueSystemEvent("exec done again", {
        sessionKey: "s1",
        contextKey: "exec:run-1",
      });

      expect(r1).toBe(true);
      expect(r2).toBe(false);

      const events = peekSystemEventEntries("s1");
      expect(events).toHaveLength(1);
      expect(events[0].text).toBe("exec done");
    });

    it("should allow same contextKey after a different one in between", () => {
      enqueueSystemEvent("a", { sessionKey: "s1", contextKey: "key-a" });
      enqueueSystemEvent("b", { sessionKey: "s1", contextKey: "key-b" });
      const r = enqueueSystemEvent("a again", { sessionKey: "s1", contextKey: "key-a" });

      expect(r).toBe(true);
      expect(peekSystemEventEntries("s1")).toHaveLength(3);
    });

    it("should allow events without contextKey even if previous had one", () => {
      enqueueSystemEvent("with key", { sessionKey: "s1", contextKey: "k1" });
      const r = enqueueSystemEvent("no key", { sessionKey: "s1" });
      expect(r).toBe(true);
      expect(peekSystemEventEntries("s1")).toHaveLength(2);
    });
  });

  describe("MAX_EVENTS eviction", () => {
    it("should evict oldest events when exceeding 20", () => {
      for (let i = 0; i < 25; i++) {
        enqueueSystemEvent(`event-${i}`, { sessionKey: "s1" });
      }

      const events = peekSystemEventEntries("s1");
      expect(events).toHaveLength(20);
      // Oldest 5 (0..4) should be evicted, keeping 5..24
      expect(events[0].text).toBe("event-5");
      expect(events[19].text).toBe("event-24");
    });
  });

  describe("drainSystemEvents", () => {
    it("should return all events and clear the queue", () => {
      enqueueSystemEvent("a", { sessionKey: "s1" });
      enqueueSystemEvent("b", { sessionKey: "s1" });

      const drained = drainSystemEvents("s1");
      expect(drained).toHaveLength(2);
      expect(drained.map((e) => e.text)).toEqual(["a", "b"]);

      // Queue should be empty now
      expect(peekSystemEventEntries("s1")).toHaveLength(0);
      expect(hasSystemEvents("s1")).toBe(false);
    });

    it("should return empty array for unknown session", () => {
      expect(drainSystemEvents("nonexistent")).toEqual([]);
    });
  });

  describe("peekSystemEventEntries", () => {
    it("should not consume events", () => {
      enqueueSystemEvent("peek me", { sessionKey: "s1" });

      peekSystemEventEntries("s1");
      peekSystemEventEntries("s1");

      expect(peekSystemEventEntries("s1")).toHaveLength(1);
    });

    it("should return a copy (not a reference)", () => {
      enqueueSystemEvent("original", { sessionKey: "s1" });
      const events = peekSystemEventEntries("s1");
      events.length = 0; // mutate the returned array

      expect(peekSystemEventEntries("s1")).toHaveLength(1);
    });
  });

  describe("hasSystemEvents", () => {
    it("should return false for empty/unknown session", () => {
      expect(hasSystemEvents("unknown")).toBe(false);
    });

    it("should return true when events are pending", () => {
      enqueueSystemEvent("hi", { sessionKey: "s1" });
      expect(hasSystemEvents("s1")).toBe(true);
    });

    it("should return false after drain", () => {
      enqueueSystemEvent("hi", { sessionKey: "s1" });
      drainSystemEvents("s1");
      expect(hasSystemEvents("s1")).toBe(false);
    });
  });

  describe("session isolation", () => {
    it("should keep events separate per session", () => {
      enqueueSystemEvent("for-a", { sessionKey: "session-a" });
      enqueueSystemEvent("for-b", { sessionKey: "session-b" });

      expect(peekSystemEventEntries("session-a")).toHaveLength(1);
      expect(peekSystemEventEntries("session-a")[0].text).toBe("for-a");

      expect(peekSystemEventEntries("session-b")).toHaveLength(1);
      expect(peekSystemEventEntries("session-b")[0].text).toBe("for-b");

      // Draining one should not affect the other
      drainSystemEvents("session-a");
      expect(hasSystemEvents("session-a")).toBe(false);
      expect(hasSystemEvents("session-b")).toBe(true);
    });
  });
});
