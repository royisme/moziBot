import { existsSync, unlinkSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { InboundMessage } from "../runtime/adapters/channels/types";
import { closeDb, initDb, withConnection } from "../storage/db";
import { buildCanonicalEnvelope, ingestInboundMessage } from "./ingest";
import { buildProviderInputPayload } from "./provider-payload";

const TEST_DB = "data/multimodal-ingest.test.db";

function cleanupTestDb() {
  if (existsSync(TEST_DB)) {
    unlinkSync(TEST_DB);
  }
  if (existsSync(`${TEST_DB}-wal`)) {
    unlinkSync(`${TEST_DB}-wal`);
  }
  if (existsSync(`${TEST_DB}-shm`)) {
    unlinkSync(`${TEST_DB}-shm`);
  }
}

describe("multimodal ingest", () => {
  beforeEach(() => {
    closeDb();
    cleanupTestDb();
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

  it("persists inbound envelope with media without FK violations", () => {
    initDb(TEST_DB, 1);

    const message: InboundMessage = {
      id: "m-media-1",
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
        },
      ],
      timestamp: new Date("2026-02-08T10:00:00.000Z"),
      raw: { any: "payload" },
    };

    const result = ingestInboundMessage({
      message,
      sessionKey: "agent:mozi:telegram:dm:chat-1",
      channelId: "telegram",
      modelRef: "openai/gpt-4o",
    });

    expect(result).not.toBeNull();

    const counts = withConnection((conn) => {
      const messageCount = (
        conn
          .prepare("SELECT COUNT(*) AS count FROM multimodal_messages WHERE id = ?")
          .get("telegram:m-media-1") as { count: number }
      ).count;
      const partCount = (
        conn
          .prepare("SELECT COUNT(*) AS count FROM multimodal_message_parts WHERE message_id = ?")
          .get("telegram:m-media-1") as { count: number }
      ).count;
      const partWithMedia = conn
        .prepare(
          "SELECT media_id FROM multimodal_message_parts WHERE message_id = ? AND modality = 'audio' LIMIT 1",
        )
        .get("telegram:m-media-1") as { media_id: string } | undefined;
      const assetCount = (
        conn
          .prepare("SELECT COUNT(*) AS count FROM multimodal_media_assets WHERE id = ?")
          .get(partWithMedia?.media_id ?? "") as { count: number }
      ).count;
      return { messageCount, partCount, assetCount, hasMediaPart: Boolean(partWithMedia?.media_id) };
    });

    expect(counts.messageCount).toBe(1);
    expect(counts.partCount).toBe(2);
    expect(counts.hasMediaPart).toBe(true);
    expect(counts.assetCount).toBe(1);
  });
});
