import { describe, expect, it, vi } from "vitest";
import type { MoziConfig } from "../../config";
import type { ChannelPlugin } from "../adapters/channels/plugin";
import type { InboundMessage } from "../adapters/channels/types";
import { MessageHandler } from "./message-handler";

function createConfig(): MoziConfig {
  return {
    models: {
      providers: {
        quotio: {
          api: "openai-responses",
          baseUrl: "https://example.invalid/v1",
          apiKey: "test-key",
          models: [{ id: "gemini-3-flash-preview" }],
        },
      },
    },
    agents: {
      mozi: {
        model: "quotio/gemini-3-flash-preview",
      },
    },
  };
}

describe("MessageHandler.startDetachedRun observability", () => {
  it("projects failed terminal with unified fields", async () => {
    const handler = new MessageHandler(createConfig());
    const h = handler as unknown as {
      agentManager: {
        getAgent: (
          sessionKey: string,
          agentId: string,
        ) => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
      };
      resolveSessionContext: (message: InboundMessage) => { sessionKey: string; agentId: string };
      handle: (message: InboundMessage, channel: ChannelPlugin) => Promise<void>;
    };

    h.agentManager = {
      getAgent: async () => ({
        agent: { messages: [] },
        modelRef: "quotio/gemini-3-flash-preview",
      }),
    };
    h.resolveSessionContext = () => ({
      sessionKey: "agent:mozi:telegram:dm:chat-1",
      agentId: "mozi",
    });

    const err = Object.assign(new Error("boom"), { code: "ACP_TURN_FAILED" });
    h.handle = vi.fn(async () => {
      throw err;
    });

    const onTerminal = vi.fn();
    const message = {
      id: "m-1",
      channel: "telegram",
      peerId: "chat-1",
      peerType: "dm",
      senderId: "u-1",
      senderName: "tester",
      text: "hello",
      timestamp: new Date(),
      raw: {},
    } as InboundMessage;
    const channel = {
      id: "telegram",
      name: "Telegram",
      connect: async () => {},
      disconnect: async () => {},
      send: async () => "out-1",
      getStatus: () => "connected",
      isConnected: () => true,
      on: () => channel,
      once: () => channel,
      off: () => channel,
      emit: () => true,
      removeAllListeners: () => channel,
    } as unknown as ChannelPlugin;

    await handler.startDetachedRun({ message, channel, queueItemId: "q-1", onTerminal });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          runId: "run:m-1",
          sessionKey: "agent:mozi:telegram:dm:chat-1",
          traceId: "turn:m-1",
        }),
        terminal: "failed",
        reason: "boom",
        errorCode: "ACP_TURN_FAILED",
      }),
    );
  });

  it("keeps terminal callback single-shot under late settle race", async () => {
    const handler = new MessageHandler(createConfig());
    const h = handler as unknown as {
      agentManager: {
        getAgent: (
          sessionKey: string,
          agentId: string,
        ) => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
      };
      resolveSessionContext: (message: InboundMessage) => { sessionKey: string; agentId: string };
      handle: (message: InboundMessage, channel: ChannelPlugin) => Promise<void>;
    };

    h.agentManager = {
      getAgent: async () => ({
        agent: { messages: [{ role: "assistant", content: "late-success" }] },
        modelRef: "quotio/gemini-3-flash-preview",
      }),
    };
    h.resolveSessionContext = () => ({
      sessionKey: "agent:mozi:telegram:dm:chat-1",
      agentId: "mozi",
    });

    const err = Object.assign(new Error("first-fail"), { code: "ACP_TURN_FAILED" });
    h.handle = vi.fn(async () => {
      throw err;
    });

    const onTerminal = vi.fn();
    const message = {
      id: "m-2",
      channel: "telegram",
      peerId: "chat-1",
      peerType: "dm",
      senderId: "u-1",
      senderName: "tester",
      text: "hello",
      timestamp: new Date(),
      raw: {},
    } as InboundMessage;
    const channel = {
      id: "telegram",
      name: "Telegram",
      connect: async () => {},
      disconnect: async () => {},
      send: async () => "out-1",
      getStatus: () => "connected",
      isConnected: () => true,
      on: () => channel,
      once: () => channel,
      off: () => channel,
      emit: () => true,
      removeAllListeners: () => channel,
    } as unknown as ChannelPlugin;

    await handler.startDetachedRun({ message, channel, queueItemId: "q-2", onTerminal });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ runId: "run:m-2", traceId: "turn:m-2" }),
        terminal: "failed",
        reason: "first-fail",
      }),
    );
  });
});
