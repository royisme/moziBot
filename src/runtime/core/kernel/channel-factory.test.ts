import { describe, expect, it, vi } from "vitest";
import type { ChannelCapabilities, ChannelActionSpec } from "../../adapters/channels/types";
import type { RuntimeEgress } from "../contracts";
import { createRuntimeChannel } from "./channel-factory";

function makeQueueItem(channelId = "telegram") {
  return {
    id: "qi-1",
    channel_id: channelId,
    session_key: "sk-1",
    attempts: 0,
  } as import("../../../storage/db").RuntimeQueueItem;
}

function makeEgress(): RuntimeEgress {
  return {
    deliver: vi.fn(async () => "out-id"),
  };
}

describe("createRuntimeChannel", () => {
  describe("getCapabilities", () => {
    it("delegates to getChannelCapabilities when provided", () => {
      const custom: ChannelCapabilities = {
        media: false,
        polls: true,
        reactions: false,
        threads: false,
        editMessage: false,
        deleteMessage: false,
        implicitCurrentTarget: false,
        supportedActions: ["send_text"],
      };
      const getChannelCapabilities = vi.fn(() => custom);

      const ch = createRuntimeChannel({
        queueItem: makeQueueItem("telegram"),
        envelopeId: "env-1",
        egress: makeEgress(),
        getChannelCapabilities,
      });

      const caps = ch.getCapabilities();

      expect(getChannelCapabilities).toHaveBeenCalledWith("telegram");
      expect(caps).toBe(custom);
    });

    it("returns fallback defaults when getChannelCapabilities is not provided", () => {
      const ch = createRuntimeChannel({
        queueItem: makeQueueItem("telegram"),
        envelopeId: "env-1",
        egress: makeEgress(),
      });

      const caps = ch.getCapabilities();

      expect(caps.media).toBe(true);
      expect(caps.supportedActions).toContain("send_text");
      expect(caps.supportedActions).toContain("send_media");
      expect(caps.supportedActions).toContain("reply");
    });

    it("passes the correct channelId from the queue item", () => {
      const getChannelCapabilities = vi.fn(() => ({}) as ChannelCapabilities);

      createRuntimeChannel({
        queueItem: makeQueueItem("discord"),
        envelopeId: "env-1",
        egress: makeEgress(),
        getChannelCapabilities,
      }).getCapabilities();

      expect(getChannelCapabilities).toHaveBeenCalledWith("discord");
    });
  });

  describe("listActions", () => {
    it("delegates to getChannelListActions when provided", () => {
      const custom: ChannelActionSpec[] = [
        { name: "send_text", enabled: true, description: "text" },
      ];
      const getChannelListActions = vi.fn(() => custom);

      const ch = createRuntimeChannel({
        queueItem: makeQueueItem("telegram"),
        envelopeId: "env-1",
        egress: makeEgress(),
        getChannelListActions,
      });

      const context = { peerType: "dm" as const };
      const actions = ch.listActions?.(context);

      expect(getChannelListActions).toHaveBeenCalledWith("telegram", context);
      expect(actions).toBe(custom);
    });

    it("returns default actions when getChannelListActions is not provided", () => {
      const ch = createRuntimeChannel({
        queueItem: makeQueueItem("telegram"),
        envelopeId: "env-1",
        egress: makeEgress(),
      });

      const actions = ch.listActions?.() ?? [];

      const names = actions.map((a) => a.name);
      expect(names).toContain("send_text");
      expect(names).toContain("send_media");
      expect(names).toContain("reply");
    });
  });
});
