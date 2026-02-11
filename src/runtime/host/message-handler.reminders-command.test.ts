import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoziConfig } from "../../config";
import type { ChannelPlugin } from "../adapters/channels/plugin";
import type { InboundMessage } from "../adapters/channels/types";
import { closeDb, initDb, reminders } from "../../storage/db";
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

function buildChannel(send: ReturnType<typeof vi.fn>): ChannelPlugin {
  const channel = {
    id: "telegram",
    name: "Telegram",
    connect: async () => {},
    disconnect: async () => {},
    send,
    getStatus: () => "connected" as const,
    isConnected: () => true,
    on: () => channel,
    once: () => channel,
    off: () => channel,
    emit: () => true,
    removeAllListeners: () => channel,
  };
  return channel as unknown as ChannelPlugin;
}

function buildMessage(text: string): InboundMessage {
  return {
    id: "m-rem-cmd-1",
    channel: "telegram",
    peerId: "user1",
    peerType: "dm",
    senderId: "u1",
    text,
    timestamp: new Date(),
    raw: {},
  };
}

const TEST_DB = "data/test-message-handler-reminders.db";

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

describe("MessageHandler /reminders command", () => {
  beforeEach(() => {
    cleanupTestDb();
    initDb(TEST_DB);
  });

  afterEach(() => {
    closeDb();
    cleanupTestDb();
  });

  it("creates and lists reminders through command interface", async () => {
    const handler = new MessageHandler(createConfig());
    const send = vi.fn(async () => "out-1");
    const channel = buildChannel(send);

    await handler.handle(buildMessage("/reminders create every 10m stand up"), channel);
    await handler.handle(buildMessage("/reminders list"), channel);

    const rows = reminders.listBySession("agent:mozi:telegram:dm:user1", { limit: 20 });
    expect(rows.length).toBeGreaterThan(0);
    expect(send).toHaveBeenCalled();
  });

  it("updates, snoozes and cancels reminders through command interface", async () => {
    const handler = new MessageHandler(createConfig());
    const send = vi.fn(async () => "out-1");
    const channel = buildChannel(send);

    await handler.handle(buildMessage("/reminders create every 10m ping"), channel);
    const row = reminders.listBySession("agent:mozi:telegram:dm:user1", { limit: 1 })[0];
    expect(row).toBeDefined();

    await handler.handle(buildMessage(`/reminders update ${row.id} every 5m ping2`), channel);
    await handler.handle(buildMessage(`/reminders snooze ${row.id} 30s`), channel);
    await handler.handle(buildMessage(`/reminders cancel ${row.id}`), channel);

    const after = reminders.getById(row.id);
    expect(after?.enabled).toBe(0);
  });
});
