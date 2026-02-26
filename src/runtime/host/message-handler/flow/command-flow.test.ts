import { describe, expect, it, vi } from "vitest";
import type { OrchestratorDeps } from "../contract";
import { runCommandFlow } from "./command-flow";

describe("runCommandFlow", () => {
  it("dispatches built-in command handlers first", async () => {
    const builtIn = vi.fn(async () => {});
    const extensionDispatch = vi.fn(async () => false);
    const result = await runCommandFlow(
      {
        messageId: "m1",
        traceId: "t1",
        type: "message",
        payload: { text: "/status" },
        startTime: Date.now(),
        state: {
          parsedCommand: { name: "status", args: "" },
          sessionKey: "s1",
          agentId: "a1",
          peerId: "p1",
          text: "/status",
        },
      },
      {
        getCommandHandlerMap: () => ({ status: builtIn }),
        getChannel: () => ({ id: "telegram", send: async () => "1" }),
        dispatchExtensionCommand: extensionDispatch,
        interruptSession: async () => false,
        performSessionReset: async () => {},
      } as unknown as OrchestratorDeps,
    );

    expect(result).toBe("handled");
    expect(builtIn).toHaveBeenCalledTimes(1);
    expect(extensionDispatch).not.toHaveBeenCalled();
  });

  it("dispatches extension command when built-in map misses", async () => {
    const extensionDispatch = vi.fn(async () => true);
    const result = await runCommandFlow(
      {
        messageId: "m1",
        traceId: "t1",
        type: "message",
        payload: { text: "/ext_ping" },
        startTime: Date.now(),
        state: {
          parsedCommand: { name: "ext_ping", args: "" },
          sessionKey: "s1",
          agentId: "a1",
          peerId: "p1",
          text: "/ext_ping",
        },
      },
      {
        getCommandHandlerMap: () => ({}),
        getChannel: () => ({ id: "telegram", send: async () => "1" }),
        dispatchExtensionCommand: extensionDispatch,
        interruptSession: async () => false,
        performSessionReset: async () => {},
      } as unknown as OrchestratorDeps,
    );

    expect(result).toBe("handled");
    expect(extensionDispatch).toHaveBeenCalledTimes(1);
  });

  it("treats unknown slash commands as handled without falling through", async () => {
    const extensionDispatch = vi.fn(async () => false);
    const result = await runCommandFlow(
      {
        messageId: "m1",
        traceId: "t1",
        type: "message",
        payload: { text: "/unknown_cmd" },
        startTime: Date.now(),
        state: {
          parsedCommand: { name: "unknown_cmd", args: "" },
          sessionKey: "s1",
          agentId: "a1",
          peerId: "p1",
          text: "/unknown_cmd",
        },
      },
      {
        getCommandHandlerMap: () => ({}),
        getChannel: () => ({ id: "telegram", send: async () => "1" }),
        dispatchExtensionCommand: extensionDispatch,
        interruptSession: async () => false,
        performSessionReset: async () => {},
      } as unknown as OrchestratorDeps,
    );

    expect(result).toBe("handled");
  });

  it("routes /new through reset flow and continues", async () => {
    const interruptSession = vi.fn(async () => true);
    const performSessionReset = vi.fn(async () => {});
    const state = {
      parsedCommand: { name: "new", args: "" },
      sessionKey: "s1",
      agentId: "a1",
      peerId: "p1",
      text: "/new",
    };
    const result = await runCommandFlow(
      {
        messageId: "m1",
        traceId: "t1",
        type: "message",
        payload: { text: "/new" },
        startTime: Date.now(),
        state,
      },
      {
        getCommandHandlerMap: () => ({}),
        getChannel: () => ({ id: "telegram", send: async () => "1" }),
        dispatchExtensionCommand: async () => false,
        interruptSession,
        performSessionReset,
      } as unknown as OrchestratorDeps,
    );

    expect(result).toBe("continue");
    expect(interruptSession).toHaveBeenCalledWith("s1", "Session reset command");
    expect(performSessionReset).toHaveBeenCalledWith({
      sessionKey: "s1",
      agentId: "a1",
      reason: "new",
    });
    expect(state.text).toContain("A new session was started via /new or /reset");
  });

  it("routes /reset with args and preserves args for prompt flow", async () => {
    const performSessionReset = vi.fn(async () => {});
    const state = {
      parsedCommand: { name: "reset", args: "hello there" },
      sessionKey: "s1",
      agentId: "a1",
      peerId: "p1",
      text: "/reset hello there",
    };
    const result = await runCommandFlow(
      {
        messageId: "m1",
        traceId: "t1",
        type: "message",
        payload: { text: "/reset hello there" },
        startTime: Date.now(),
        state,
      },
      {
        getCommandHandlerMap: () => ({}),
        getChannel: () => ({ id: "telegram", send: async () => "1" }),
        dispatchExtensionCommand: async () => false,
        interruptSession: async () => false,
        performSessionReset,
      } as unknown as OrchestratorDeps,
    );

    expect(result).toBe("continue");
    expect(performSessionReset).toHaveBeenCalledWith({
      sessionKey: "s1",
      agentId: "a1",
      reason: "reset",
    });
    expect(state.text).toBe("hello there");
  });
});
