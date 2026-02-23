import { afterEach, describe, expect, it, vi } from "vitest";
import { agentEvents } from "../../../../infra/agent-events";
import { runPromptWithFallback, type PromptAgent, type PromptRunnerDeps } from "./prompt-runner";

function buildDeps(agent: PromptAgent): PromptRunnerDeps {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    agentManager: {
      getAgent: vi.fn(async () => ({ agent, modelRef: "model-1" })),
      getAgentFallbacks: vi.fn(() => []),
      setSessionModel: vi.fn(async () => {}),
      clearRuntimeModelOverride: vi.fn(() => {}),
      resolvePromptTimeoutMs: vi.fn(() => 1_000),
    },
    errorClassifiers: {
      isAgentBusyError: vi.fn(() => false),
      isContextOverflowError: vi.fn(() => false),
      isAbortError: vi.fn(() => false),
      isTransientError: vi.fn(() => false),
      toError: (err) => (err instanceof Error ? err : new Error(String(err))),
    },
  };
}

describe("runPromptWithFallback agent events", () => {
  afterEach(() => {
    agentEvents.removeAllListeners();
  });

  it("emits lifecycle start/end for successful runs", async () => {
    const handler = vi.fn();
    agentEvents.on("agent-event", handler);

    const agent: PromptAgent = {
      prompt: vi.fn(async () => {}),
    };

    await runPromptWithFallback({
      sessionKey: "agent:mozi:dm:peer-1",
      agentId: "mozi",
      text: "hello",
      traceId: "turn:t1",
      deps: buildDeps(agent),
      activeMap: new Map(),
      interruptedSet: new Set(),
    });

    const lifecycleEvents = handler.mock.calls
      .map((call) => call[0])
      .filter((event) => event.stream === "lifecycle");

    expect(lifecycleEvents).toHaveLength(2);
    expect(lifecycleEvents[0]).toEqual(
      expect.objectContaining({
        runId: "turn:t1",
        sessionKey: "agent:mozi:dm:peer-1",
        data: expect.objectContaining({ phase: "start" }),
      }),
    );
    expect(lifecycleEvents[1]).toEqual(
      expect.objectContaining({
        runId: "turn:t1",
        data: expect.objectContaining({ phase: "end" }),
      }),
    );
  });

  it("emits tool events from agent stream", async () => {
    const handler = vi.fn();
    agentEvents.on("agent-event", handler);

    let listener: ((event: unknown) => void) | undefined;
    const agent: PromptAgent = {
      prompt: vi.fn(async () => {
        listener?.({
          type: "tool_execution_start",
          toolName: "sessions_list",
          toolCallId: "call-1",
        });
        listener?.({
          type: "tool_execution_end",
          toolName: "sessions_list",
          toolCallId: "call-1",
          isError: false,
        });
      }),
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    };

    await runPromptWithFallback({
      sessionKey: "agent:mozi:dm:peer-2",
      agentId: "mozi",
      text: "hello",
      traceId: "turn:t2",
      onStream: async () => {},
      deps: buildDeps(agent),
      activeMap: new Map(),
      interruptedSet: new Set(),
    });

    const toolEvents = handler.mock.calls
      .map((call) => call[0])
      .filter((event) => event.stream === "tool");

    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]).toEqual(
      expect.objectContaining({
        runId: "turn:t2",
        data: expect.objectContaining({ toolName: "sessions_list", status: "called" }),
      }),
    );
    expect(toolEvents[1]).toEqual(
      expect.objectContaining({
        runId: "turn:t2",
        data: expect.objectContaining({ toolName: "sessions_list", status: "completed" }),
      }),
    );
  });

  it("emits lifecycle error when prompt fails", async () => {
    const handler = vi.fn();
    agentEvents.on("agent-event", handler);

    const agent: PromptAgent = {
      prompt: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    await expect(
      runPromptWithFallback({
        sessionKey: "agent:mozi:dm:peer-3",
        agentId: "mozi",
        text: "hello",
        traceId: "turn:t3",
        deps: buildDeps(agent),
        activeMap: new Map(),
        interruptedSet: new Set(),
      }),
    ).rejects.toThrow("boom");

    const lifecycleEvents = handler.mock.calls
      .map((call) => call[0])
      .filter((event) => event.stream === "lifecycle");

    expect(lifecycleEvents).toHaveLength(2);
    expect(lifecycleEvents[0].data.phase).toBe("start");
    expect(lifecycleEvents[1]).toEqual(
      expect.objectContaining({
        runId: "turn:t3",
        data: expect.objectContaining({ phase: "error", error: "boom" }),
      }),
    );
  });
});
