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
    sendVideo: ReturnType<typeof vi.fn>;
    sendAudio: ReturnType<typeof vi.fn>;
    sendVoice: ReturnType<typeof vi.fn>;
    sendAnimation: ReturnType<typeof vi.fn>;
    sendVideoNote: ReturnType<typeof vi.fn>;
    sendChatAction: ReturnType<typeof vi.fn>;
    setMessageReaction: ReturnType<typeof vi.fn>;
    deleteMessage: ReturnType<typeof vi.fn>;
    editMessageText: ReturnType<typeof vi.fn>;
    answerCallbackQuery: ReturnType<typeof vi.fn>;
    deleteMyCommands: ReturnType<typeof vi.fn>;
    setMyCommands: ReturnType<typeof vi.fn>;
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
        config: { use: vi.fn() },
        getMe: vi.fn().mockResolvedValue({ id: 42, username: "mozi_bot" }),
        sendMessage: vi.fn().mockResolvedValue({ message_id: 123 }),
        sendPhoto: vi.fn().mockResolvedValue({ message_id: 124 }),
        sendDocument: vi.fn().mockResolvedValue({ message_id: 125 }),
        sendVideo: vi.fn().mockResolvedValue({ message_id: 126 }),
        sendAudio: vi.fn().mockResolvedValue({ message_id: 127 }),
        sendVoice: vi.fn().mockResolvedValue({ message_id: 128 }),
        sendAnimation: vi.fn().mockResolvedValue({ message_id: 129 }),
        sendVideoNote: vi.fn().mockResolvedValue({ message_id: 130 }),
        sendChatAction: vi.fn().mockResolvedValue(true),
        setMessageReaction: vi.fn().mockResolvedValue(true),
        deleteMessage: vi.fn().mockResolvedValue(true),
        editMessageText: vi.fn().mockResolvedValue({ message_id: 123 }),
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        deleteMyCommands: vi.fn().mockResolvedValue(true),
        setMyCommands: vi.fn().mockResolvedValue(true),
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

  it("should register native commands including skills", async () => {
    await plugin.connect();
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;
    expect(botInstance.api.setMyCommands).toHaveBeenCalled();
    const commands = botInstance.api.setMyCommands.mock.calls.at(-1)?.[0] as Array<{
      command: string;
      description: string;
    }>;
    expect(commands.some((entry) => entry.command === "skills")).toBe(true);
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

  it("should send video message", async () => {
    const buffer = Buffer.from("test-video");
    const messageId = await plugin.send("12345", {
      text: "video caption",
      media: [{ type: "video", buffer, filename: "video.mp4" }],
    });
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;
    expect(messageId).toBe("126");
    expect(botInstance.api.sendVideo).toHaveBeenCalledWith(
      "12345",
      expect.any(Object),
      expect.objectContaining({ caption: "video caption" }),
    );
  });

  it("should send video as video note when asVideoNote is true", async () => {
    const buffer = Buffer.from("test-video-note");
    const messageId = await plugin.send("12345", {
      text: "video note text",
      media: [{ type: "video", buffer, asVideoNote: true }],
    });
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;
    expect(messageId).toBe("130");
    expect(botInstance.api.sendVideoNote).toHaveBeenCalledWith(
      "12345",
      expect.any(Object),
      expect.objectContaining({}),
    );
    // Video note should not have caption
    expect(botInstance.api.sendVideo).not.toHaveBeenCalled();
  });

  it("should send video_note message", async () => {
    const buffer = Buffer.from("test-video-note");
    const messageId = await plugin.send("12345", {
      media: [{ type: "video_note", buffer }],
    });
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;
    expect(messageId).toBe("130");
    expect(botInstance.api.sendVideoNote).toHaveBeenCalledWith(
      "12345",
      expect.any(Object),
      expect.objectContaining({
        reply_markup: undefined,
      }),
    );
  });

  it("should send audio message", async () => {
    const buffer = Buffer.from("test-audio");
    const messageId = await plugin.send("12345", {
      text: "audio caption",
      media: [{ type: "audio", buffer, filename: "audio.mp3" }],
    });
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;
    expect(messageId).toBe("127");
    expect(botInstance.api.sendAudio).toHaveBeenCalledWith(
      "12345",
      expect.any(Object),
      expect.objectContaining({ caption: "audio caption" }),
    );
  });

  it("should send audio as voice when asVoice is true", async () => {
    const buffer = Buffer.from("test-voice");
    const messageId = await plugin.send("12345", {
      text: "voice caption",
      media: [{ type: "audio", buffer, asVoice: true }],
    });
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;
    expect(messageId).toBe("128");
    expect(botInstance.api.sendVoice).toHaveBeenCalledWith(
      "12345",
      expect.any(Object),
      expect.objectContaining({ caption: "voice caption" }),
    );
    expect(botInstance.api.sendAudio).not.toHaveBeenCalled();
  });

  it("should send voice message", async () => {
    const buffer = Buffer.from("test-voice");
    const messageId = await plugin.send("12345", {
      text: "voice note",
      media: [{ type: "voice", buffer }],
    });
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;
    expect(messageId).toBe("128");
    expect(botInstance.api.sendVoice).toHaveBeenCalledWith(
      "12345",
      expect.any(Object),
      expect.objectContaining({ caption: "voice note" }),
    );
  });

  it("should send animation message", async () => {
    const buffer = Buffer.from("test-animation");
    const messageId = await plugin.send("12345", {
      text: "animation caption",
      media: [{ type: "animation", buffer, filename: "animation.gif" }],
    });
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;
    expect(messageId).toBe("129");
    expect(botInstance.api.sendAnimation).toHaveBeenCalledWith(
      "12345",
      expect.any(Object),
      expect.objectContaining({ caption: "animation caption" }),
    );
  });

  it("should send gif as animation", async () => {
    const buffer = Buffer.from("test-gif");
    const messageId = await plugin.send("12345", {
      text: "gif caption",
      media: [{ type: "gif", buffer, filename: "image.gif" }],
    });
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;
    expect(messageId).toBe("129");
    expect(botInstance.api.sendAnimation).toHaveBeenCalledWith(
      "12345",
      expect.any(Object),
      expect.objectContaining({ caption: "gif caption" }),
    );
  });

  it("should send document message", async () => {
    const buffer = Buffer.from("test-document");
    const messageId = await plugin.send("12345", {
      text: "doc caption",
      media: [{ type: "document", buffer, filename: "file.pdf" }],
    });
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;
    expect(messageId).toBe("125");
    expect(botInstance.api.sendDocument).toHaveBeenCalledWith(
      "12345",
      expect.any(Object),
      expect.objectContaining({ caption: "doc caption" }),
    );
  });

  it("should send unknown media type as document", async () => {
    const buffer = Buffer.from("test-unknown");
    const messageId = await plugin.send("12345", {
      text: "unknown caption",
      media: [{ type: "unknown" as unknown as "document", buffer, filename: "file.xyz" }],
    });
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;
    expect(messageId).toBe("125");
    expect(botInstance.api.sendDocument).toHaveBeenCalledWith(
      "12345",
      expect.any(Object),
      expect.objectContaining({ caption: "unknown caption" }),
    );
  });

  it("should fall back to text when media has no buffer", async () => {
    const messageId = await plugin.send("12345", {
      text: "fallback text",
      media: [{ type: "photo" as const, buffer: undefined }],
    });
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;
    expect(messageId).toBe("123");
    expect(botInstance.api.sendMessage).toHaveBeenCalledWith(
      "12345",
      "fallback text",
      expect.any(Object),
    );
    expect(botInstance.api.sendPhoto).not.toHaveBeenCalled();
  });

  it("should retry with plain text on parse error", async () => {
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;

    // Make sendMessage throw a parse error first time
    botInstance.api.sendMessage
      .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
      .mockResolvedValueOnce({ message_id: 999 });

    const messageId = await plugin.send("12345", {
      text: "test *bold* text",
    });

    expect(messageId).toBe("999");
    // Should have called sendMessage twice - first with HTML, then with plain text
    expect(botInstance.api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("should pass reply_markup with media messages", async () => {
    const buffer = Buffer.from("test-image");
    const messageId = await plugin.send("12345", {
      text: "photo with buttons",
      media: [{ type: "photo", buffer }],
      buttons: [[{ text: "Button1", callbackData: "cb1" }]],
    });
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;
    expect(messageId).toBe("124");
    expect(botInstance.api.sendPhoto).toHaveBeenCalledWith(
      "12345",
      expect.any(Object),
      expect.objectContaining({
        caption: "photo with buttons",
        reply_markup: {
          inline_keyboard: [[{ text: "Button1", callback_data: "cb1" }]],
        },
      }),
    );
  });

  it("should pass parse_mode as HTML for media messages", async () => {
    const buffer = Buffer.from("test-image");
    const messageId = await plugin.send("12345", {
      text: "caption with *markdown*",
      media: [{ type: "photo", buffer }],
    });
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results[0].value;
    expect(messageId).toBe("124");
    expect(botInstance.api.sendPhoto).toHaveBeenCalledWith(
      "12345",
      expect.any(Object),
      expect.objectContaining({
        parse_mode: "HTML",
      }),
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

  it("should set status reaction when enabled", async () => {
    plugin = new TelegramPlugin({
      botToken: "test-token",
      statusReactions: { enabled: true },
    });
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results.at(-1)?.value;
    expect(botInstance).toBeDefined();
    if (!botInstance) {
      return;
    }

    await plugin.setStatusReaction?.("12345", "456", "thinking");

    expect(botInstance.api.setMessageReaction).toHaveBeenCalledWith("12345", 456, [
      { type: "emoji", emoji: "🤔" },
    ]);
  });

  it("should skip status reaction when disabled", async () => {
    plugin = new TelegramPlugin({
      botToken: "test-token",
      statusReactions: { enabled: false },
    });
    const botInstance = (Bot as unknown as MockWithResults<MockedBot>).mock.results.at(-1)?.value;
    expect(botInstance).toBeDefined();
    if (!botInstance) {
      return;
    }

    await plugin.setStatusReaction?.("12345", "456", "thinking");

    expect(botInstance.api.setMessageReaction).not.toHaveBeenCalled();
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
