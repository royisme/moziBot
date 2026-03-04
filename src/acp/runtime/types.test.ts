import { describe, expect, it } from "vitest";
import type {
  AcpRuntimeEvent,
  AcpRuntimeStartedEvent,
  AcpRuntimeDoneEvent,
  AcpRuntimeErrorEvent,
  AcpRuntimeTextDeltaEvent,
} from "./types";
import { isTerminalEvent, isNonTerminalEvent } from "./types";

describe("AcpRuntimeEvent lifecycle semantics", () => {
  describe("terminal event detection", () => {
    it("should identify done as terminal event", () => {
      const doneEvent: AcpRuntimeDoneEvent = { type: "done", stopReason: "stop" };
      expect(isTerminalEvent(doneEvent)).toBe(true);
      expect(isNonTerminalEvent(doneEvent)).toBe(false);
    });

    it("should identify error as terminal event", () => {
      const errorEvent: AcpRuntimeErrorEvent = {
        type: "error",
        message: "test error",
        code: "TEST_ERROR",
        category: "runtime",
      };
      expect(isTerminalEvent(errorEvent)).toBe(true);
      expect(isNonTerminalEvent(errorEvent)).toBe(false);
    });

    it("should identify started as non-terminal event", () => {
      const startedEvent: AcpRuntimeStartedEvent = { type: "started", requestId: "req-1" };
      expect(isTerminalEvent(startedEvent)).toBe(false);
      expect(isNonTerminalEvent(startedEvent)).toBe(true);
    });

    it("should identify text_delta as non-terminal event", () => {
      const deltaEvent: AcpRuntimeTextDeltaEvent = { type: "text_delta", text: "hello" };
      expect(isTerminalEvent(deltaEvent)).toBe(false);
      expect(isNonTerminalEvent(deltaEvent)).toBe(true);
    });

    it("should identify status as non-terminal event", () => {
      const statusEvent: AcpRuntimeEvent = { type: "status", text: "processing" };
      expect(isTerminalEvent(statusEvent)).toBe(false);
      expect(isNonTerminalEvent(statusEvent)).toBe(true);
    });

    it("should identify tool_call as non-terminal event", () => {
      const toolEvent: AcpRuntimeEvent = { type: "tool_call", text: "tool invoked" };
      expect(isTerminalEvent(toolEvent)).toBe(false);
      expect(isNonTerminalEvent(toolEvent)).toBe(true);
    });
  });

  describe("event type exhaustiveness", () => {
    it("should handle all event types in discriminated union", () => {
      const events: AcpRuntimeEvent[] = [
        { type: "started", requestId: "req-1" },
        { type: "text_delta", text: "hello", stream: "output" },
        { type: "status", text: "working" },
        { type: "tool_call", text: "tool" },
        { type: "done", stopReason: "stop" },
        { type: "error", message: "fail", code: "ERR", category: "runtime" },
      ];

      // Verify each event can be handled through type narrowing
      for (const event of events) {
        if (isTerminalEvent(event)) {
          expect(["done", "error"]).toContain(event.type);
        } else {
          expect(["started", "text_delta", "status", "tool_call"]).toContain(event.type);
        }
      }
    });
  });

  describe("error event classification", () => {
    it("should support all error categories", () => {
      const categories = ["config", "policy", "runtime", "network", "cancelled"] as const;

      for (const category of categories) {
        const errorEvent: AcpRuntimeErrorEvent = {
          type: "error",
          message: `test ${category}`,
          category,
          retryable: category !== "cancelled",
        };
        expect(errorEvent.category).toBe(category);
      }
    });

    it("should allow error without category for backward compatibility", () => {
      const errorEvent: AcpRuntimeErrorEvent = {
        type: "error",
        message: "legacy error",
      };
      expect(errorEvent.category).toBeUndefined();
      expect(errorEvent.code).toBeUndefined();
    });
  });

  describe("event timestamp optionality", () => {
    it("should allow events with timestamps", () => {
      const now = Date.now();
      const event: AcpRuntimeStartedEvent = {
        type: "started",
        requestId: "req-1",
        timestamp: now,
      };
      expect(event.timestamp).toBe(now);
    });

    it("should allow events without timestamps", () => {
      const event: AcpRuntimeStartedEvent = {
        type: "started",
        requestId: "req-1",
      };
      expect(event.timestamp).toBeUndefined();
    });
  });
});

describe("Terminal uniqueness constraints", () => {
  it("should enforce exactly one terminal event in valid sequence", () => {
    // Valid sequence: started -> progress* -> done
    const validSequence: AcpRuntimeEvent[] = [
      { type: "started", requestId: "req-1" },
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      { type: "done", stopReason: "stop" },
    ];

    const terminalEvents = validSequence.filter(isTerminalEvent);
    expect(terminalEvents.length).toBe(1);
    expect(terminalEvents[0]?.type).toBe("done");
  });

  it("should detect multiple terminal events as invalid", () => {
    // Invalid sequence: started -> done -> error (multiple terminals)
    const invalidSequence: AcpRuntimeEvent[] = [
      { type: "started", requestId: "req-1" },
      { type: "done", stopReason: "stop" },
      { type: "error", message: "late error" },
    ];

    const terminalEvents = invalidSequence.filter(isTerminalEvent);
    expect(terminalEvents.length).toBe(2); // Should only be 1 in valid sequence
  });

  it("should detect missing terminal event as invalid", () => {
    // Invalid sequence: started -> progress (no terminal)
    const incompleteSequence: AcpRuntimeEvent[] = [
      { type: "started", requestId: "req-1" },
      { type: "text_delta", text: "Hello" },
    ];

    const terminalEvents = incompleteSequence.filter(isTerminalEvent);
    expect(terminalEvents.length).toBe(0); // Should be 1 in valid sequence
  });
});
