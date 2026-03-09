import { describe, expect, it } from "vitest";
import { planOutboundByNegotiation } from "./outbound";

const telegramContext = {
  channelId: "telegram",
  peerId: "chat-1",
  peerType: "group" as const,
  capabilities: {
    media: true,
    polls: false,
    reactions: true,
    threads: true,
    editMessage: true,
    deleteMessage: true,
    implicitCurrentTarget: true,
    supportedActions: ["send_text", "send_media", "reply"],
  },
  allowedActions: ["send_text", "send_media", "reply"],
  defaultTarget: { peerId: "chat-1", threadId: "topic-1", replyToId: "msg-1" },
};

describe("multimodal outbound planning", () => {
  it("keeps text output when text modality allowed", () => {
    const outbound = planOutboundByNegotiation({
      channelId: "telegram",
      text: "hello",
      currentChannel: telegramContext,
      inboundPlan: {
        acceptedInput: [],
        providerInput: [],
        outputModalities: ["text"],
        transforms: [],
        fallbackUsed: false,
      },
    });
    expect(outbound.actions[0]).toMatchObject({ type: "send_text", text: "hello" });
  });

  it("returns fallback message when text output not allowed", () => {
    const outbound = planOutboundByNegotiation({
      channelId: "discord",
      text: "hello",
      currentChannel: {
        ...telegramContext,
        channelId: "discord",
        allowedActions: ["send_text"],
        capabilities: {
          ...telegramContext.capabilities,
          supportedActions: ["send_text"],
        },
      },
      inboundPlan: {
        acceptedInput: [],
        providerInput: [],
        outputModalities: ["audio"],
        transforms: [],
        fallbackUsed: false,
      },
    });
    expect(outbound.actions).toEqual([]);
    expect(outbound.fallbackText).toBe("This channel does not support text output.");
  });

  it("prefers send_media when media is allowed", () => {
    const outbound = planOutboundByNegotiation({
      channelId: "telegram",
      text: "here is the file",
      currentChannel: telegramContext,
      media: [{ type: "document", path: "/tmp/report.txt", filename: "report.txt" }],
      inboundPlan: null,
    });
    expect(outbound.actions[0]).toMatchObject({
      type: "send_media",
      text: "here is the file",
    });
  });

  it("keeps send_media legal when send_text is disallowed", () => {
    const outbound = planOutboundByNegotiation({
      channelId: "telegram",
      text: "artifact blocked",
      currentChannel: {
        ...telegramContext,
        allowedActions: ["send_media"],
      },
      media: [{ type: "document", path: "/tmp/report.txt", filename: "report.txt" }],
      inboundPlan: null,
    });

    expect(outbound.actions[0]).toMatchObject({
      type: "send_media",
      text: "artifact blocked",
    });
  });
});
