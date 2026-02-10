import { beforeEach, describe, expect, it } from "vitest";
import type { InboundMessage } from "../runtime/adapters/channels/types";
import { closeDb } from "../storage/db";
import { buildCanonicalEnvelope, ingestInboundMessage } from "./ingest";
import { buildProviderInputPayload } from "./provider-payload";

describe("multimodal ingest", () => {
  beforeEach(() => {
    closeDb();
  });

  it("builds canonical envelope with media metadata", () => {
    const message: InboundMessage = {
      id: "m1",
      channel: "telegram",
      peerId: "chat-1",
      peerType: "dm",
      senderId: "u1",
      text: "hello",
      media: [
        {
          type: "voice",
          url: "voice-file-id",
          mimeType: "audio/ogg",
          byteSize: 1234,
          durationMs: 2000,
          caption: "note",
        },
      ],
      timestamp: new Date("2026-02-08T10:00:00.000Z"),
      raw: { any: "payload" },
    };

    const envelope = buildCanonicalEnvelope({
      message,
      sessionKey: "agent:mozi:telegram:dm:chat-1",
    });

    expect(envelope.parts.length).toBe(2);
    expect(envelope.parts[1]).toMatchObject({
      modality: "audio",
      media: {
        mimeType: "audio/ogg",
        byteSize: 1234,
        durationMs: 2000,
      },
      metadata: {
        sourceUrl: "voice-file-id",
        caption: "note",
      },
    });
  });

  it("returns null when DB is not initialized", () => {
    const message: InboundMessage = {
      id: "m2",
      channel: "telegram",
      peerId: "chat-1",
      peerType: "dm",
      senderId: "u1",
      text: "hello",
      timestamp: new Date(),
      raw: {},
    };

    const result = ingestInboundMessage({
      message,
      sessionKey: "agent:mozi:telegram:dm:chat-1",
      channelId: "telegram",
      modelRef: "openai/gpt-4o",
    });
    expect(result).toBeNull();
  });

  it("builds provider payload from fallback plan", () => {
    const payload = buildProviderInputPayload({
      acceptedInput: [],
      providerInput: [
        {
          id: "p1",
          role: "user",
          index: 0,
          modality: "text",
          text: "hello",
          format: "plain",
        },
      ],
      outputModalities: ["text"],
      transforms: [
        {
          type: "summarize",
          from: "audio",
          to: "text",
          reason: "fallback",
        },
      ],
      fallbackUsed: true,
    });

    expect(payload.text).toBe("hello");
    expect(payload.metadata.fallbackUsed).toBe(true);
    expect(payload.metadata.transforms[0]).toMatchObject({ from: "audio", to: "text" });
  });
});
