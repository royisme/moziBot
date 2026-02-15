import { run } from "@grammyjs/runner";
import { Bot } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramPlugin } from "./plugin";

// Type for mocked Bot
interface MockedBot {
  use: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  catch: ReturnType<typeof vi.fn>;
  api: {
    getMe: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    sendPhoto: ReturnType<typeof vi.fn>;
    sendDocument: ReturnType<typeof vi.fn>;
    sendChatAction: ReturnType<typeof vi.fn>;
    setMessageReaction: ReturnType<typeof vi.fn>;
    deleteMessage: ReturnType<typeof vi.fn>;
    editMessageText: ReturnType<typeof vi.fn>;
    answerCallbackQuery: ReturnType<typeof vi.fn>;
  };
}

interface MockWithResults<T> {
  mock: { results: { value: T }[] };
}

// Mock grammy
vi.mock("grammy", () => {
  const BotMock = vi.fn().mockImplementation(function BotMockImpl() {
    return {
      use: vi.fn(),
      on: vi.fn(),
      catch: vi.fn(),
      api: {
        getMe: vi.fn().mockResolvedValue({ id: 42, username: "mozi_bot" }),
        sendMessage: vi.fn().mockResolvedValue({ message_id: 123 }),
        sendPhoto: vi.fn().mockResolvedValue({ message_id: 124 }),
        sendDocument: vi.fn().mockResolvedValue({ message_id: 125 }),
        sendChatAction: vi.fn().mockResolvedValue(true),
        setMessageReaction: vi.fn().mockResolvedValue(true),
        deleteMessage: vi.fn().mockResolvedValue(true),
        editMessageText: vi.fn().mockResolvedValue({ message_id: 123 }),
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
      },
    };
  });
  class InputFileMock {
    data: unknown;

    constructor(data: unknown) {
      this.data = data;
    }
  }
  return { Bot: BotMock, Context: vi.fn(), InputFile: InputFileMock };
});

vi.mock("@grammyjs/runner", () => ({
  run: vi.fn().mockImplementation(() => {
    let resolveTask: (() => void) | null = null;
    const taskPromise = new Promise<void>((resolve) => {
      resolveTask = resolve;
    });
    return {
      stop: vi.fn().mockImplementation(async () => {
        resolveTask?.();
      }),
      task: vi.fn().mockImplementation(() => taskPromise),
    };
  }),
  sequentialize: vi.fn().mockReturnValue((_ctx: unknown, next: () => Promise<void>) => next()),
}));

describe("TelegramPlugin", () => {
  let plugin: TelegramPlugin;
  const config = { botToken: "test-token" };

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    plugin = new TelegramPlugin(config);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await plugin.disconnect();
  });

  it("should have correct id and name", () => {
    expect(plugin.id).toBe("telegram");
    expect(plugin.name).toBe("Telegram");
  });

  it("should call run on connect", async () => {
    await plugin.connect();
    expect(run).toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        runner: expect.objectContaining({
          fetch: expect.objectContaining({ timeout: 30 }),
          maxRetryTime: 60_000,
          retryInterval: "exponential",
          silent: true,
        }),
      }),
    );
    expect(plugin.getStatus()).toBe("connected");
  });

  it("should call stop on disconnect", async () => {
    await plugin.connect();
    await plugin.disconnect();
    const runnerInstance = (run as unknown as MockWithResults<{ stop: ReturnType<typeof vi.fn> }>)
      .mock.results[0].value;
    expect(runnerInstance.stop).toHaveBeenCalled();
    expect(plugin.getStatus()).toBe("disconnected");
  });

  it("should send text message", async () => {
    const messageId = await plugin.send("12345", { text: "hello", traceId: "turn:abc" });
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;
    expect(messageId).toBe("123");
    expect(botInstance.api.sendMessage).toHaveBeenCalledWith("12345", "hello", expect.any(Object));
  });

  it("should send photo message", async () => {
    const buffer = Buffer.from("test-image");
    const messageId = await plugin.send("12345", {
      text: "photo caption",
      media: [{ type: "photo", buffer }],
    });
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;
    expect(messageId).toBe("124");
    expect(botInstance.api.sendPhoto).toHaveBeenCalledWith(
      "12345",
      expect.any(Object),
      expect.objectContaining({ caption: "photo caption" }),
    );
  });

  it("should send inline buttons", async () => {
    await plugin.send("12345", {
      text: "choose",
      buttons: [[{ text: "Btn1", callbackData: "cb1" }]],
    });
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;
    expect(botInstance.api.sendMessage).toHaveBeenCalledWith(
      "12345",
      "choose",
      expect.objectContaining({
        reply_markup: {
          inline_keyboard: [[{ text: "Btn1", callback_data: "cb1" }]],
        },
      }),
    );
  });

  it("should send typing indicator while typing is active", async () => {
    await plugin.connect();
    vi.useFakeTimers();
    try {
      const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;

      const stopTyping = await plugin.beginTyping?.("12345");
      expect(botInstance.api.sendChatAction).toHaveBeenCalledTimes(1);
      expect(botInstance.api.sendChatAction).toHaveBeenLastCalledWith("12345", "typing");

      await vi.advanceTimersByTimeAsync(6000);
      expect(botInstance.api.sendChatAction).toHaveBeenCalledTimes(2);

      await stopTyping?.();
      await vi.advanceTimersByTimeAsync(12000);
      expect(botInstance.api.sendChatAction).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should convert inbound message correctly", async () => {
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;
    const handler = botInstance.on.mock.calls.find(
      (call: unknown[]) => (call[0] as string) === "message:text",
    )?.[1] as ((ctx: unknown) => Promise<void>) | undefined;
    expect(handler).toBeDefined();
    if (!handler) {
      return;
    }

    const mockCtx = {
      message: {
        message_id: 456,
        chat: { id: 789, type: "private" },
        from: { id: 101, first_name: "John", last_name: "Doe" },
        text: "hello bot",
        date: 1675468800,
      },
    };

    let receivedMsg: unknown;
    plugin.on("message", (msg) => {
      receivedMsg = msg;
    });

    await handler(mockCtx);

    expect(receivedMsg).toBeDefined();
    type ReceivedMsg = {
      id: string;
      peerId: string;
      senderName: string;
      text: string;
    };
    expect((receivedMsg as ReceivedMsg).id).toBe("456");
    expect((receivedMsg as ReceivedMsg).peerId).toBe("789");
    expect((receivedMsg as ReceivedMsg).senderName).toBe("John");
    expect((receivedMsg as ReceivedMsg).text).toBe("hello bot");
  });

  it("should map inbound voice metadata", async () => {
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;
    const handler = botInstance.on.mock.calls.find(
      (call: unknown[]) => (call[0] as string) === "message:voice",
    )?.[1] as ((ctx: unknown) => Promise<void>) | undefined;
    expect(handler).toBeDefined();
    if (!handler) {
      return;
    }

    let receivedMsg: unknown;
    plugin.on("message", (msg) => {
      receivedMsg = msg;
    });

    await handler({
      message: {
        message_id: 457,
        chat: { id: 789, type: "private" },
        from: { id: 101, first_name: "John" },
        caption: "voice note",
        voice: {
          file_id: "voice-file-1",
          mime_type: "audio/ogg",
          duration: 2,
          file_size: 2048,
        },
        date: 1675468800,
      },
    });

    const inbound = receivedMsg as { media?: Array<Record<string, unknown>> };
    expect(inbound.media?.[0]).toMatchObject({
      type: "voice",
      url: "voice-file-1",
      mimeType: "audio/ogg",
      caption: "voice note",
      byteSize: 2048,
      durationMs: 2000,
    });
  });

  it("should respect allowedChats whitelist", async () => {
    const whiteListedPlugin = new TelegramPlugin({
      ...config,
      allowedChats: ["123"],
    });
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[1].value;
    const handler = botInstance.on.mock.calls.find(
      (call: unknown[]) => (call[0] as string) === "message:text",
    )?.[1] as ((ctx: unknown) => Promise<void>) | undefined;
    expect(handler).toBeDefined();
    if (!handler) {
      return;
    }

    let receivedMsg: unknown;
    whiteListedPlugin.on("message", (msg) => {
      receivedMsg = msg;
    });

    // Ignored message
    await handler({
      message: {
        message_id: 1,
        chat: { id: 456, type: "private" },
        date: 1675468800,
        text: "hi",
      },
    });
    expect(receivedMsg).toBeUndefined();

    // Allowed message
    await handler({
      message: {
        message_id: 2,
        chat: { id: 123, type: "private" },
        date: 1675468800,
        text: "hi",
      },
    });
    expect(receivedMsg).toBeDefined();
    expect((receivedMsg as { id: string }).id).toBe("2");
  });

  it("should enforce dm allowlist policy", async () => {
    const allowedPlugin = new TelegramPlugin({
      ...config,
      dmPolicy: "allowlist",
      allowFrom: ["101"],
    });
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[1].value;
    const handler = botInstance.on.mock.calls.find(
      (call: unknown[]) => (call[0] as string) === "message:text",
    )?.[1] as ((ctx: unknown) => Promise<void>) | undefined;
    expect(handler).toBeDefined();
    if (!handler) {
      return;
    }

    let received = false;
    allowedPlugin.on("message", () => {
      received = true;
    });

    await handler({
      message: {
        message_id: 9,
        chat: { id: 999, type: "private" },
        from: { id: 202, first_name: "Blocked" },
        date: 1675468800,
        text: "hi",
      },
    });
    expect(received).toBe(false);

    await handler({
      message: {
        message_id: 10,
        chat: { id: 999, type: "private" },
        from: { id: 101, first_name: "Allowed" },
        date: 1675468800,
        text: "hi",
      },
    });
    expect(received).toBe(true);
  });

  it("should enforce group requireMention policy", async () => {
    const mentionPlugin = new TelegramPlugin({
      ...config,
      groups: {
        "-1001": { requireMention: true },
      },
    });
    await mentionPlugin.connect();

    try {
      const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[1].value;
      const handler = botInstance.on.mock.calls.find(
        (call: unknown[]) => (call[0] as string) === "message:text",
      )?.[1] as ((ctx: unknown) => Promise<void>) | undefined;
      expect(handler).toBeDefined();
      if (!handler) {
        return;
      }

      let received = false;
      mentionPlugin.on("message", () => {
        received = true;
      });

      await handler({
        message: {
          message_id: 11,
          chat: { id: -1001, type: "supergroup" },
          from: { id: 101, first_name: "Member" },
          date: 1675468800,
          text: "hello everyone",
        },
      });
      expect(received).toBe(false);

      await handler({
        message: {
          message_id: 12,
          chat: { id: -1001, type: "supergroup" },
          from: { id: 101, first_name: "Member" },
          date: 1675468800,
          text: "hello @mozi_bot",
        },
      });
      expect(received).toBe(true);
    } finally {
      await mentionPlugin.disconnect();
    }
  });
});
