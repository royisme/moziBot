import { afterEach, describe, expect, it, vi } from "vitest";
import { agentEvents } from "../../../../infra/agent-events";
import { runPromptWithFallback, type PromptAgent, type PromptRunnerDeps } from "./prompt-runner";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runLlmInput: vi.fn(async () => {}),
    runLlmOutput: vi.fn(async () => {}),
    runAgentEnd: vi.fn(async () => {}),
  },
}));

vi.mock("../../../hooks", () => ({
  getRuntimeHookRunner: () => hookMocks.runner,
}));

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
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runLlmInput.mockClear();
    hookMocks.runner.runLlmOutput.mockClear();
    hookMocks.runner.runAgentEnd.mockClear();
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

  it("emits llm_input and llm_output hooks for successful runs", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name: string) =>
      name === "llm_input" || name === "llm_output",
    );

    const agent: PromptAgent = {
      prompt: vi.fn(async () => {}),
      subscribe: (next) => {
        next({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } });
        return () => undefined;
      },
    };

    await runPromptWithFallback({
      sessionKey: "agent:mozi:dm:peer-llm",
      agentId: "mozi",
      text: "sk-THIS_SHOULD_REDACT",
      traceId: "turn:llm",
      onStream: async () => {},
      deps: buildDeps(agent),
      activeMap: new Map(),
      interruptedSet: new Set(),
    });

    expect(hookMocks.runner.runLlmInput).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runLlmInput).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "turn:llm",
        modelRef: "model-1",
        attempt: 1,
        promptText: expect.not.stringContaining("sk-THIS_SHOULD_REDACT"),
      }),
      expect.objectContaining({
        sessionKey: "agent:mozi:dm:peer-llm",
        agentId: "mozi",
      }),
    );

    expect(hookMocks.runner.runLlmOutput).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runLlmOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "turn:llm",
        modelRef: "model-1",
        attempt: 1,
        status: "success",
      }),
      expect.objectContaining({
        sessionKey: "agent:mozi:dm:peer-llm",
        agentId: "mozi",
      }),
    );
  });

  it("emits llm_output hook on error", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name: string) => name === "llm_output");

    const agent: PromptAgent = {
      prompt: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    await expect(
      runPromptWithFallback({
        sessionKey: "agent:mozi:dm:peer-error",
        agentId: "mozi",
        text: "hello",
        traceId: "turn:error",
        deps: buildDeps(agent),
        activeMap: new Map(),
        interruptedSet: new Set(),
      }),
    ).rejects.toThrow("boom");

    expect(hookMocks.runner.runLlmInput).not.toHaveBeenCalled();
    expect(hookMocks.runner.runLlmOutput).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runLlmOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "turn:error",
        modelRef: "model-1",
        attempt: 1,
        status: "error",
        error: "boom",
      }),
      expect.objectContaining({
        sessionKey: "agent:mozi:dm:peer-error",
        agentId: "mozi",
      }),
    );
  });

  it("emits agent_end hook on success", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name: string) => name === "agent_end");

    const agent: PromptAgent = {
      prompt: vi.fn(async () => {}),
      messages: [{ role: "assistant", content: "done" }],
    };

    await runPromptWithFallback({
      sessionKey: "agent:mozi:dm:peer-end",
      agentId: "mozi",
      text: "hello",
      traceId: "turn:agent-end",
      deps: buildDeps(agent),
      activeMap: new Map(),
      interruptedSet: new Set(),
    });

    expect(hookMocks.runner.runAgentEnd).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runAgentEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "turn:agent-end",
        success: true,
        messages: expect.any(Array),
      }),
      expect.objectContaining({
        sessionKey: "agent:mozi:dm:peer-end",
        agentId: "mozi",
      }),
    );
  });

  it("emits agent_end hook on error", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name: string) => name === "agent_end");

    const agent: PromptAgent = {
      prompt: vi.fn(async () => {
        throw new Error("boom");
      }),
      messages: [],
    };

    await expect(
      runPromptWithFallback({
        sessionKey: "agent:mozi:dm:peer-end-error",
        agentId: "mozi",
        text: "hello",
        traceId: "turn:agent-end-error",
        deps: buildDeps(agent),
        activeMap: new Map(),
        interruptedSet: new Set(),
      }),
    ).rejects.toThrow("boom");

    expect(hookMocks.runner.runAgentEnd).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runAgentEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "turn:agent-end-error",
        success: false,
        error: "boom",
      }),
      expect.objectContaining({
        sessionKey: "agent:mozi:dm:peer-end-error",
        agentId: "mozi",
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
