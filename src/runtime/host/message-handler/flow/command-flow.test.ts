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
      } as unknown as OrchestratorDeps,
    );

    expect(result).toBe("handled");
  });
});
