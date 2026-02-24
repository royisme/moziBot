import { describe, expect, it, vi } from "vitest";
import { createRuntimeHookRunner, RuntimeHookRegistry } from "./runner";

describe("RuntimeHookRunner", () => {
  it("replaces existing hook when registering with the same id", async () => {
    const registry = new RuntimeHookRegistry();
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    registry.register("turn_completed", first, { id: "test:hook" });
    registry.register("turn_completed", second, { id: "test:hook" });

    const runner = createRuntimeHookRunner(registry);
    await runner.runTurnCompleted(
      { traceId: "t1", messageId: "m1", status: "success", durationMs: 10 },
      { sessionKey: "s1", agentId: "a1" },
    );

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("supports unregister by id", async () => {
    const registry = new RuntimeHookRegistry();
    const hook = vi.fn(async () => {});
    registry.register("turn_completed", hook, { id: "remove:me" });
    expect(registry.unregister("remove:me")).toBe(true);
    expect(registry.unregister("remove:me")).toBe(false);

    const runner = createRuntimeHookRunner(registry);
    await runner.runTurnCompleted(
      { traceId: "t1", messageId: "m1", status: "success", durationMs: 10 },
      { sessionKey: "s1", agentId: "a1" },
    );

    expect(hook).not.toHaveBeenCalled();
  });

  it("runs observer hooks in parallel and isolates errors", async () => {
    const registry = new RuntimeHookRegistry();
    const errorSpy = vi.fn();
    const visited: string[] = [];
    registry.register(
      "turn_completed",
      async () => {
        visited.push("a");
      },
      { priority: 10 },
    );
    registry.register("turn_completed", async () => {
      throw new Error("boom");
    });
    registry.register("turn_completed", async () => {
      visited.push("b");
    });

    const runner = createRuntimeHookRunner(registry, {
      catchErrors: true,
      logger: { error: errorSpy },
    });

    await runner.runTurnCompleted(
      { traceId: "t1", messageId: "m1", status: "success", durationMs: 10 },
      { sessionKey: "s1", agentId: "a1" },
    );

    expect(visited.toSorted()).toEqual(["a", "b"]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("applies before_tool_call in priority order and supports modification", async () => {
    const registry = new RuntimeHookRegistry();
    registry.register(
      "before_tool_call",
      async (event) => ({ args: { ...event.args, step: ["p1"] } }),
      { priority: 10 },
    );
    registry.register("before_tool_call", async (event) => ({
      args: {
        ...event.args,
        step: [...((event.args.step as string[]) ?? []), "p2"],
      },
    }));

    const runner = createRuntimeHookRunner(registry);
    const result = await runner.runBeforeToolCall(
      { toolName: "exec", args: { cmd: "ls" } },
      { sessionKey: "s1", agentId: "a1" },
    );

    expect(result?.args).toEqual({ cmd: "ls", step: ["p1", "p2"] });
  });

  it("supports block semantics in before_tool_call", async () => {
    const registry = new RuntimeHookRegistry();
    const tail = vi.fn();
    registry.register(
      "before_tool_call",
      async () => ({ block: true, blockReason: "blocked-by-test" }),
      { priority: 10 },
    );
    registry.register("before_tool_call", tail);

    const runner = createRuntimeHookRunner(registry);
    const result = await runner.runBeforeToolCall(
      { toolName: "exec", args: { cmd: "ls" } },
      { sessionKey: "s1", agentId: "a1" },
    );

    expect(result).toEqual({ block: true, blockReason: "blocked-by-test" });
    expect(tail).not.toHaveBeenCalled();
  });

  it("supports prompt mutation in before_agent_start", async () => {
    const registry = new RuntimeHookRegistry();
    registry.register("before_agent_start", async (event) => ({
      promptText: `${event.promptText}\n\n[Hooked]`,
    }));

    const runner = createRuntimeHookRunner(registry);
    const result = await runner.runBeforeAgentStart(
      { promptText: "hello" },
      { sessionKey: "s1", agentId: "a1", traceId: "t1", messageId: "m1" },
    );

    expect(result?.promptText).toContain("[Hooked]");
  });

  it("runs message_received hooks", async () => {
    const registry = new RuntimeHookRegistry();
    const handler = vi.fn();
    registry.register("message_received", handler);

    const runner = createRuntimeHookRunner(registry);
    await runner.runMessageReceived(
      {
        traceId: "t1",
        messageId: "m1",
        text: "hello",
        rawStartsWithSlash: false,
        isCommand: false,
        mediaCount: 0,
      },
      { sessionKey: "s1", agentId: "a1", channelId: "telegram" },
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "m1", text: "hello" }),
      expect.objectContaining({ channelId: "telegram" }),
    );
  });

  it("runs message_sent hooks", async () => {
    const registry = new RuntimeHookRegistry();
    const handler = vi.fn();
    registry.register("message_sent", handler);

    const runner = createRuntimeHookRunner(registry);
    await runner.runMessageSent(
      {
        traceId: "t1",
        messageId: "m1",
        replyText: "hi",
        outboundId: "out-1",
        deliveryMode: "direct_dispatch",
        channelId: "telegram",
        peerId: "peer-1",
      },
      { sessionKey: "s1", agentId: "a1" },
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "m1", replyText: "hi" }),
      expect.objectContaining({ sessionKey: "s1" }),
    );
  });

  it("runs message_sending hooks and supports modification/cancel", async () => {
    const registry = new RuntimeHookRegistry();
    const modify = vi.fn(async () => ({ replyText: "modified" }));
    const cancel = vi.fn(async () => ({ cancel: true }));
    registry.register("message_sending", modify, { priority: 10 });
    registry.register("message_sending", cancel);

    const runner = createRuntimeHookRunner(registry);
    const result = await runner.runMessageSending(
      { traceId: "t1", messageId: "m1", replyText: "original", to: "peer-1" },
      { sessionKey: "s1", agentId: "a1" },
    );

    expect(modify).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ cancel: true, cancelReason: undefined });
  });

  it("returns modified replyText from message_sending hooks", async () => {
    const registry = new RuntimeHookRegistry();
    registry.register("message_sending", async () => ({ replyText: "modified" }));

    const runner = createRuntimeHookRunner(registry);
    const result = await runner.runMessageSending(
      { traceId: "t2", messageId: "m2", replyText: "original", to: "peer-2" },
      { sessionKey: "s2", agentId: "a2" },
    );

    expect(result).toEqual({ replyText: "modified" });
  });

  it("runs llm_input/llm_output hooks and reports availability", async () => {
    const registry = new RuntimeHookRegistry();
    const inputHandler = vi.fn();
    registry.register("llm_input", inputHandler);

    const runner = createRuntimeHookRunner(registry);
    await runner.runLlmInput(
      {
        runId: "run-1",
        modelRef: "model-1",
        attempt: 1,
        promptText: "hello",
      },
      { sessionKey: "s1", agentId: "a1" },
    );

    expect(inputHandler).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", promptText: "hello" }),
      expect.objectContaining({ sessionKey: "s1" }),
    );
    expect(runner.hasHooks("llm_input")).toBe(true);
    expect(runner.hasHooks("llm_output")).toBe(false);
  });

  it("runs compaction hooks", async () => {
    const registry = new RuntimeHookRegistry();
    const before = vi.fn();
    const after = vi.fn();
    registry.register("before_compaction", before);
    registry.register("after_compaction", after);

    const runner = createRuntimeHookRunner(registry);
    await runner.runBeforeCompaction(
      { messageCount: 3, compactingCount: 3, tokenCount: 10 },
      { sessionKey: "s1", agentId: "a1" },
    );
    await runner.runAfterCompaction(
      { messageCount: 2, compactedCount: 1, tokenCount: 8 },
      { sessionKey: "s1", agentId: "a1" },
    );

    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("runs agent_end hooks", async () => {
    const registry = new RuntimeHookRegistry();
    const handler = vi.fn();
    registry.register("agent_end", handler);

    const runner = createRuntimeHookRunner(registry);
    await runner.runAgentEnd(
      { runId: "r1", success: true, durationMs: 12 },
      { sessionKey: "s1", agentId: "a1" },
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "r1", success: true }),
      expect.objectContaining({ sessionKey: "s1" }),
    );
  });
});
