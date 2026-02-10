import { describe, it, expect, vi, afterEach } from "vitest";
import {
  agentEvents,
  onAgentEvent,
  type AgentLifecycleEvent,
  type AgentToolEvent,
} from "./agent-events";

describe("AgentEventEmitter", () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    agentEvents.removeAllListeners();
  });

  describe("emitLifecycle", () => {
    it("should emit lifecycle events with correct structure", () => {
      const handler = vi.fn();
      cleanup = onAgentEvent(handler);

      const eventData: Omit<AgentLifecycleEvent, "stream"> = {
        runId: "run-123",
        sessionKey: "agent:test:session",
        data: {
          phase: "start",
          startedAt: Date.now(),
        },
      };

      agentEvents.emitLifecycle(eventData);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: "lifecycle",
          runId: "run-123",
          sessionKey: "agent:test:session",
          data: expect.objectContaining({
            phase: "start",
            startedAt: expect.any(Number),
          }),
        }),
      );
    });

    it("should support all lifecycle phases", () => {
      const phases: Array<"start" | "end" | "error"> = ["start", "end", "error"];
      const handler = vi.fn();
      cleanup = onAgentEvent(handler);

      phases.forEach((phase) => {
        agentEvents.emitLifecycle({
          runId: `run-${phase}`,
          sessionKey: "agent:test:session",
          data: { phase },
        });
      });

      expect(handler).toHaveBeenCalledTimes(3);
      expect(handler.mock.calls[0][0].data.phase).toBe("start");
      expect(handler.mock.calls[1][0].data.phase).toBe("end");
      expect(handler.mock.calls[2][0].data.phase).toBe("error");
    });

    it("should include error information for error phase", () => {
      const handler = vi.fn();
      cleanup = onAgentEvent(handler);

      agentEvents.emitLifecycle({
        runId: "run-456",
        sessionKey: "agent:test:session",
        data: {
          phase: "error",
          error: "Test error message",
          endedAt: Date.now(),
        },
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "error",
            error: "Test error message",
            endedAt: expect.any(Number),
          }),
        }),
      );
    });
  });

  describe("emitTool", () => {
    it("should emit tool events with correct structure", () => {
      const handler = vi.fn();
      cleanup = onAgentEvent(handler);

      const eventData: Omit<AgentToolEvent, "stream"> = {
        runId: "run-789",
        sessionKey: "agent:test:session",
        data: {
          toolName: "sessions_spawn",
          status: "called",
          result: { childKey: "child:123" },
        },
      };

      agentEvents.emitTool(eventData);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: "tool",
          runId: "run-789",
          sessionKey: "agent:test:session",
          data: expect.objectContaining({
            toolName: "sessions_spawn",
            status: "called",
            result: { childKey: "child:123" },
          }),
        }),
      );
    });

    it("should support all tool statuses", () => {
      const statuses: Array<"called" | "completed" | "error"> = ["called", "completed", "error"];
      const handler = vi.fn();
      cleanup = onAgentEvent(handler);

      statuses.forEach((status) => {
        agentEvents.emitTool({
          runId: `run-${status}`,
          sessionKey: "agent:test:session",
          data: {
            toolName: "sessions_list",
            status,
          },
        });
      });

      expect(handler).toHaveBeenCalledTimes(3);
      expect(handler.mock.calls[0][0].data.status).toBe("called");
      expect(handler.mock.calls[1][0].data.status).toBe("completed");
      expect(handler.mock.calls[2][0].data.status).toBe("error");
    });
  });

  describe("onAgentEvent", () => {
    it("should return a cleanup function that removes the listener", () => {
      const handler = vi.fn();
      cleanup = onAgentEvent(handler);

      agentEvents.emitLifecycle({
        runId: "run-1",
        sessionKey: "agent:test:session",
        data: { phase: "start" },
      });

      expect(handler).toHaveBeenCalledTimes(1);

      cleanup();

      agentEvents.emitLifecycle({
        runId: "run-2",
        sessionKey: "agent:test:session",
        data: { phase: "end" },
      });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should support multiple listeners", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const cleanup1 = onAgentEvent(handler1);
      cleanup = onAgentEvent(handler2);

      agentEvents.emitLifecycle({
        runId: "run-multi",
        sessionKey: "agent:test:session",
        data: { phase: "start" },
      });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);

      cleanup1();
    });

    it("should isolate events to their stream type", () => {
      const lifecycleHandler = vi.fn();
      const toolHandler = vi.fn();

      const cleanup1 = onAgentEvent((evt) => {
        if (evt.stream === "lifecycle") {
          lifecycleHandler(evt);
        }
      });
      const cleanup2 = onAgentEvent((evt) => {
        if (evt.stream === "tool") {
          toolHandler(evt);
        }
      });
      cleanup = () => {
        cleanup1();
        cleanup2();
      };

      agentEvents.emitLifecycle({
        runId: "run-lifecycle",
        sessionKey: "agent:test:session",
        data: { phase: "start" },
      });

      agentEvents.emitTool({
        runId: "run-tool",
        sessionKey: "agent:test:session",
        data: {
          toolName: "sessions_list",
          status: "called",
        },
      });

      expect(lifecycleHandler).toHaveBeenCalledTimes(1);
      expect(toolHandler).toHaveBeenCalledTimes(1);
      expect(lifecycleHandler).toHaveBeenCalledWith(
        expect.objectContaining({ stream: "lifecycle" }),
      );
      expect(toolHandler).toHaveBeenCalledWith(expect.objectContaining({ stream: "tool" }));
    });
  });

  describe("singleton behavior", () => {
    it("should maintain the same instance across imports", () => {
      const handler = vi.fn();
      cleanup = onAgentEvent(handler);

      agentEvents.emitLifecycle({
        runId: "run-singleton",
        sessionKey: "agent:test:session",
        data: { phase: "start" },
      });

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
