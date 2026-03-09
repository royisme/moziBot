import { describe, expect, it, vi } from "vitest";
import { buildReplyOutbound, dispatchReply } from "./reply-dispatcher";

const telegramChannel = {
  id: "telegram",
  send: vi.fn(async () => "out-1"),
  getCapabilities: () => ({
    media: true,
    polls: false,
    reactions: true,
    threads: true,
    editMessage: true,
    deleteMessage: true,
    implicitCurrentTarget: true,
    supportedActions: ["send_text", "send_media", "reply", "edit", "delete", "react"],
  }),
  listActions: () => [
    { name: "send_text", enabled: true },
    { name: "send_media", enabled: true },
    { name: "reply", enabled: true },
    { name: "edit", enabled: true },
    { name: "delete", enabled: true },
    { name: "react", enabled: true },
  ],
};

describe("reply-dispatcher", () => {
  it("redacts leaked reasoning preamble by default for external channels", () => {
    const outbound = buildReplyOutbound({
      channelId: "telegram",
      currentChannel: {
        channelId: "telegram",
        peerId: "chat-1",
        peerType: "group",
        capabilities: telegramChannel.getCapabilities(),
        allowedActions: ["send_text", "send_media", "reply", "edit", "delete", "react"],
        defaultTarget: { peerId: "chat-1" },
      },
      replyText: "Reasoning:\n用户问好。\n\n你好！有什么我可以帮你的吗？",
      inboundPlan: null,
    });

    expect(outbound.actions[0]).toMatchObject({ text: "你好！有什么我可以帮你的吗？" });
    expect(JSON.stringify(outbound)).not.toContain("Reasoning:");
  });

  it("redacts think-tag content by default for external channels", () => {
    const outbound = buildReplyOutbound({
      channelId: "telegram",
      currentChannel: {
        channelId: "telegram",
        peerId: "chat-1",
        peerType: "group",
        capabilities: telegramChannel.getCapabilities(),
        allowedActions: ["send_text", "send_media", "reply", "edit", "delete", "react"],
        defaultTarget: { peerId: "chat-1" },
      },
      replyText: "<think>internal</think>visible",
      inboundPlan: null,
    });

    expect(outbound.actions[0]).toMatchObject({ text: "visible" });
    expect(JSON.stringify(outbound)).not.toContain("internal");
    expect(JSON.stringify(outbound)).not.toContain("<think>");
  });

  it("preserves thinking only for localDesktop with showThinking enabled", () => {
    const outbound = buildReplyOutbound({
      channelId: "localDesktop",
      currentChannel: {
        channelId: "localDesktop",
        peerId: "desktop-default",
        peerType: "dm",
        capabilities: {
          media: true,
          polls: false,
          reactions: false,
          threads: false,
          editMessage: false,
          deleteMessage: false,
          implicitCurrentTarget: true,
          supportedActions: ["send_text", "send_media", "reply"],
        },
        allowedActions: ["send_text", "send_media", "reply"],
        defaultTarget: { peerId: "desktop-default" },
      },
      replyText: "Reasoning:\nstep\n\nanswer",
      inboundPlan: null,
      showThinking: true,
    });

    expect(outbound.actions[0]).toMatchObject({ text: expect.stringContaining("Reasoning:") });
    expect(outbound.actions[0]).toMatchObject({ text: expect.stringContaining("answer") });
  });

  it("dispatchReply applies redaction guard before send", async () => {
    const send = vi.fn(async () => "out-1");

    await dispatchReply({
      channel: { ...telegramChannel, send },
      delivery: {
        route: {
          channelId: "telegram",
          peerId: "chat-1",
          peerType: "group",
        },
        traceId: "trace-1",
      },
      replyText: "<think>hidden</think>hello",
      inboundPlan: null,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const firstCall = send.mock.calls[0] as unknown[] | undefined;
    expect(firstCall).toBeDefined();
    const payload = (firstCall && firstCall.length > 1 ? firstCall[1] : {}) as {
      text?: string;
      traceId?: string;
      replyToId?: string;
    };
    expect(payload.text).toBe("hello");
    expect(payload.traceId).toBe("trace-1");
  });

  it("dispatchReply flattens route threadId/replyToId onto outbound message", async () => {
    const send = vi.fn(async () => "out-2");

    await dispatchReply({
      channel: { ...telegramChannel, send },
      delivery: {
        route: {
          channelId: "telegram",
          peerId: "chat-2",
          peerType: "group",
          threadId: "topic-42",
          replyToId: "msg-7",
        },
        traceId: "trace-2",
      },
      replyText: "hello thread",
      inboundPlan: null,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      "chat-2",
      expect.objectContaining({
        text: "hello thread",
        threadId: "topic-42",
        replyToId: "msg-7",
        traceId: "trace-2",
      }),
    );
  });

  it("dispatchReply sends media to the current Telegram conversation", async () => {
    const send = vi.fn(async () => "out-media");

    await dispatchReply({
      channel: { ...telegramChannel, send },
      delivery: {
        route: {
          channelId: "telegram",
          peerId: "chat-media",
          peerType: "group",
          threadId: "topic-media",
          replyToId: "msg-media",
        },
        traceId: "trace-media",
        sessionKey: "session-media",
      },
      replyText: "here is the file",
      inboundPlan: null,
      media: [{ type: "document", path: "/tmp/report.txt", filename: "report.txt" }],
    });

    expect(send).toHaveBeenCalledWith(
      "chat-media",
      expect.objectContaining({
        text: "here is the file",
        media: [{ type: "document", path: "/tmp/report.txt", filename: "report.txt" }],
        threadId: "topic-media",
        replyToId: "msg-media",
        traceId: "trace-media",
      }),
    );
  });
});
