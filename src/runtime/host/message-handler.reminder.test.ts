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

describe("MessageHandler reminder delivery", () => {
  it("sends deterministic reminder message without running agent prompt", async () => {
    const handler = new MessageHandler(createConfig());
    const send = vi.fn(async () => "out-1");

    const channel = {
      id: "telegram",
      name: "Telegram",
      connect: async () => {},
      disconnect: async () => {},
      send,
      getStatus: () => "connected",
      isConnected: () => true,
      on: () => channel,
      once: () => channel,
      off: () => channel,
      emit: () => true,
      removeAllListeners: () => channel,
    } as unknown as ChannelPlugin;

    const message: InboundMessage = {
      id: "m-rem-1",
      channel: "telegram",
      peerId: "user1",
      peerType: "dm",
      senderId: "system:reminder",
      text: "Time to stand up",
      timestamp: new Date(),
      raw: {
        source: "reminder",
        reminderId: "rem-1",
      },
    };

    await handler.handle(message, channel);
    expect(send).toHaveBeenCalledWith("user1", { text: "Time to stand up" });
  });
});
