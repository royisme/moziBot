import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { ChannelActionName, ChannelActionSpec } from "../../../adapters/channels/types";
import {
  buildCurrentChannelContextFromDelivery,
  buildCurrentChannelContextFromInbound,
} from "./current-channel-context";

const TELEGRAM_ACTIONS = [
  "send_text",
  "send_media",
  "reply",
  "edit",
  "delete",
  "react",
] as const satisfies readonly ChannelActionName[];

const TELEGRAM_ACTION_SPECS: ChannelActionSpec[] = TELEGRAM_ACTIONS.map((name) => ({
  name,
  enabled: true,
}));

const plugin = Object.assign(new EventEmitter(), {
  id: "telegram",
  name: "Telegram",
  connect: async () => {},
  disconnect: async () => {},
  send: async () => "out-1",
  getStatus: () => "connected" as const,
  isConnected: () => true,
  getCapabilities: () => ({
    media: true,
    polls: false,
    reactions: true,
    threads: true,
    editMessage: true,
    deleteMessage: true,
    implicitCurrentTarget: true,
    maxTextLength: 4096,
    maxCaptionLength: 1024,
    supportedActions: [...TELEGRAM_ACTIONS],
  }),
  listActions: () => TELEGRAM_ACTION_SPECS,
});

describe("current-channel-context", () => {
  it("builds context from inbound message", () => {
    const context = buildCurrentChannelContextFromInbound({
      plugin,
      sessionKey: "session-1",
      message: {
        id: "msg-1",
        channel: "telegram",
        peerId: "chat-1",
        peerType: "group",
        senderId: "user-1",
        text: "hello",
        raw: {},
        timestamp: new Date("2026-03-09T00:00:00.000Z"),
        threadId: "topic-1",
        replyToId: "reply-1",
        accountId: "acct-1",
      },
    });

    expect(context).toMatchObject({
      channelId: "telegram",
      peerId: "chat-1",
      peerType: "group",
      accountId: "acct-1",
      threadId: "topic-1",
      replyToId: "reply-1",
      sessionKey: "session-1",
      allowedActions: ["send_text", "send_media", "reply", "edit", "delete", "react"],
      defaultTarget: {
        peerId: "chat-1",
        threadId: "topic-1",
        replyToId: "reply-1",
      },
    });
  });

  it("builds context from delivery route", () => {
    const context = buildCurrentChannelContextFromDelivery({
      plugin,
      delivery: {
        route: {
          channelId: "telegram",
          peerId: "chat-2",
          peerType: "group",
          threadId: "topic-2",
          replyToId: "reply-2",
          accountId: "acct-2",
        },
        sessionKey: "session-2",
      },
    });

    expect(context.defaultTarget).toEqual({
      peerId: "chat-2",
      threadId: "topic-2",
      replyToId: "reply-2",
    });
    expect(context.allowedActions).toContain("send_media");
  });

  it("preserves default target on fallback-only lowering", async () => {
    const { lowerChannelActionEnvelopeToOutbound } =
      await import("../../../adapters/channels/action-dispatch");
    const context = buildCurrentChannelContextFromDelivery({
      plugin,
      delivery: {
        route: {
          channelId: "telegram",
          peerId: "chat-3",
          peerType: "group",
          threadId: "topic-3",
          replyToId: "reply-3",
        },
        sessionKey: "session-3",
      },
    });

    const lowered = lowerChannelActionEnvelopeToOutbound({
      envelope: { actions: [], fallbackText: "fallback" },
      currentChannel: context,
      traceId: "trace-3",
    });

    expect(lowered.peerId).toBe("chat-3");
    expect(lowered.messages[0]).toMatchObject({
      text: "fallback",
      threadId: "topic-3",
      replyToId: "reply-3",
      traceId: "trace-3",
    });
  });
});
