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
});
