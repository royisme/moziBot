import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../adapters/channels/types";
import { RuntimeRouter } from "./router";
import {
  normalizeRouteContext,
  routeContextFromInbound,
  routeContextToOutboundMessage,
  sameRouteContext,
} from "./routing/route-context";

function message(overrides: Partial<InboundMessage>): InboundMessage {
  return {
    id: "m1",
    channel: "telegram",
    peerId: "-1001",
    peerType: "group",
    senderId: "u1",
    senderName: "Alice",
    text: "hello",
    timestamp: new Date(),
    raw: {},
    ...overrides,
  };
}

describe("RuntimeRouter", () => {
  it("normalizes optional route fields to strings", () => {
    const route = normalizeRouteContext({
      channelId: "telegram",
      peerId: "-1001",
      peerType: "group",
      accountId: 42,
      threadId: 99,
      replyToId: 7,
    });

    expect(route).toEqual({
      channelId: "telegram",
      peerId: "-1001",
      peerType: "group",
      accountId: "42",
      threadId: "99",
      replyToId: "7",
    });
  });

  it("derives canonical route context from inbound message", () => {
    const inbound = message({
      channel: "telegram",
      peerId: "chat-123",
      peerType: "dm",
      accountId: "acct-1",
      threadId: 1234,
      replyToId: "reply-1",
    });

    expect(routeContextFromInbound(inbound)).toEqual({
      channelId: "telegram",
      peerId: "chat-123",
      peerType: "dm",
      accountId: "acct-1",
      threadId: "1234",
      replyToId: "reply-1",
    });
  });

  it("projects route thread/reply fields onto outbound message", () => {
    const outbound = routeContextToOutboundMessage(
      {
        channelId: "telegram",
        peerId: "chat-1",
        peerType: "dm",
        threadId: "567",
        replyToId: "123",
      },
      { text: "hello" },
    );

    expect(outbound.threadId).toBe("567");
    expect(outbound.replyToId).toBe("123");
  });

  it("compares two canonical route contexts", () => {
    const a = normalizeRouteContext({
      channelId: "telegram",
      peerId: "chat-1",
      peerType: "dm",
      accountId: 1,
      threadId: 2,
      replyToId: 3,
    });
    const b = normalizeRouteContext({
      channelId: "telegram",
      peerId: "chat-1",
      peerType: "dm",
      accountId: "1",
      threadId: "2",
      replyToId: "3",
    });

    expect(sameRouteContext(a, b)).toBe(true);
    expect(
      sameRouteContext(
        a,
        normalizeRouteContext({
          channelId: "telegram",
          peerId: "chat-2",
          peerType: "dm",
        }),
      ),
    ).toBe(false);
  });
  it("prefers telegram group-specific agent binding", () => {
    const router = new RuntimeRouter({
      channels: {
        telegram: {
          agentId: "mozi",
          groups: {
            "-1001": { agentId: "dev-pm" },
          },
        },
      },
    });

    const route = router.resolve(message({}), "mozi");
    expect(route.agentId).toBe("dev-pm");
  });

  it("uses channel-level dmScope over global dmScope", () => {
    const router = new RuntimeRouter({
      channels: {
        dmScope: "main",
        telegram: {
          dmScope: "per-peer",
        },
      },
    });

    const route = router.resolve(message({ peerType: "dm", peerId: "1282978471" }), "mozi");
    expect(route.dmScope).toBe("per-peer");
  });

  it("falls back to routing defaults when no binding matches", () => {
    const router = new RuntimeRouter({
      channels: {
        routing: {
          dmAgentId: "mozi",
          groupAgentId: "dev-arch",
        },
      },
    });

    const route = router.resolve(message({ channel: "discord" }), "mozi");
    expect(route.agentId).toBe("dev-arch");
  });

  it("routes discord guild messages by role mapping", () => {
    const router = new RuntimeRouter({
      channels: {
        discord: {
          guilds: {
            "guild-1": {
              roleRouting: {
                "role-1": { agentId: "dev-pm" },
                "role-2": { agentId: "dev-arch" },
              },
            },
          },
        },
      },
    });

    const route = router.resolve(
      message({
        channel: "discord",
        peerType: "group",
        raw: { guildId: "guild-1", memberRoleIds: ["role-2"] },
      }),
      "mozi",
    );

    expect(route.agentId).toBe("dev-arch");
  });
});
