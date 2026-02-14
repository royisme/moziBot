import { describe, expect, it, vi } from "vitest";
import { dispatchParsedCommand } from "./dispatch";

describe("dispatchParsedCommand", () => {
  it("dispatches think command to handler", async () => {
    const onThink = vi.fn(async () => {});
    const result = await dispatchParsedCommand({
      parsedCommand: { name: "think", args: "low" },
      sessionKey: "s1",
      agentId: "a1",
      message: {
        id: "m1",
        channel: "telegram",
        peerId: "p1",
        peerType: "dm",
        senderId: "u1",
        text: "/think low",
        timestamp: new Date(),
        raw: {},
      },
      channel: {
        id: "telegram",
        name: "Telegram",
      } as never,
      peerId: "p1",
      handlers: {
        onHelp: async () => {},
        onWhoami: async () => {},
        onStatus: async () => {},
        onNew: async () => {},
        onModels: async () => {},
        onSwitch: async () => {},
        onStop: async () => false,
        onRestart: async () => {},
        onCompact: async () => {},
        onContext: async () => {},
        onAuth: async () => {},
        onReminders: async () => {},
        onHeartbeat: async () => {},
        onThink,
        onReasoning: async () => {},
      },
    });

    expect(onThink).toHaveBeenCalledWith("low");
    expect(result).toEqual({ handled: true, command: "think" });
  });
});
