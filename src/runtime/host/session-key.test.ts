import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../adapters/channels/types";
import { buildSessionKey } from "./session-key";

const baseMessage: InboundMessage = {
  id: "m1",
  channel: "telegram",
  peerId: "123",
  peerType: "dm",
  senderId: "123",
  text: "hello",
  timestamp: new Date(),
  raw: {},
};

describe("buildSessionKey", () => {
  it("uses identity links for dm scope isolation", () => {
    const sessionKey = buildSessionKey({
      agentId: "mozi",
      message: baseMessage,
      dmScope: "per-peer",
      identityLinks: {
        alice: ["telegram:123", "discord:456"],
      },
    });

    expect(sessionKey).toBe("agent:mozi:dm:alice");
  });
});
