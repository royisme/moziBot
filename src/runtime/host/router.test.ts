import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../adapters/channels/types";
import { RuntimeRouter } from "./router";

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
});
