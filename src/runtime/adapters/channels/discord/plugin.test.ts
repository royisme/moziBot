import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCommand } from "../../../host/commands/parser";
import { DiscordPlugin } from "./plugin";

type MockClient = {
  listeners: Array<{
    type?: string;
    handle: (data: unknown, client: MockClient) => Promise<void>;
  }>;
  commands: Array<unknown>;
  handleDeployRequest: ReturnType<typeof vi.fn>;
  rest: {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  getPlugin: (id: string) => unknown;
};

const mockState = vi.hoisted(() => {
  const mockClients: MockClient[] = [];
  const mockGateways: MockGatewayPlugin[] = [];
  const activePlugins: unknown[] = [];

  class MockReadyListener {
    readonly type = "READY";

    async handle(_data: unknown, _client: MockClient): Promise<void> {}
  }

  class MockMessageCreateListener {
    readonly type = "MESSAGE_CREATE";

    async handle(_data: unknown, _client: MockClient): Promise<void> {}
  }

  class MockGatewayPlugin {
    readonly id = "gateway";
    readonly emitter = new EventEmitter();
    readonly registerClient = vi.fn();
    readonly disconnect = vi.fn();

    constructor(_options: unknown) {
      mockGateways.push(this);
    }
  }

  const ClientMock = vi.fn().mockImplementation(function ClientMockImpl(
    _options,
    handlers,
    plugins = [],
  ) {
    const client: MockClient = {
      listeners: handlers?.listeners ?? [],
      commands: [],
      handleDeployRequest: vi.fn().mockResolvedValue({}),
      rest: {
        get: vi.fn().mockResolvedValue({ id: "channel-1", type: 0 }),
        post: vi.fn().mockResolvedValue({ id: "sent-123" }),
        put: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
      getPlugin: (id: string) => plugins.find((plugin: { id?: string }) => plugin.id === id),
    };

    mockClients.push(client);
    for (const plugin of plugins) {
      plugin.registerClient?.(client);
    }
    return client;
  });

  return {
    mockClients,
    mockGateways,
    activePlugins,
    MockReadyListener,
    MockMessageCreateListener,
    MockGatewayPlugin,
    ClientMock,
  };
});

const { mockClients, mockGateways } = mockState;
const activePlugins = mockState.activePlugins as DiscordPlugin[];

const originalFetch = globalThis.fetch;

vi.mock("@buape/carbon", () => ({
  Client: mockState.ClientMock,
  ReadyListener: mockState.MockReadyListener,
  MessageCreateListener: mockState.MockMessageCreateListener,
  Command: class MockCommand {
    name = "mock";
    description = "mock command";
    defer = false;
    options = [];
    async run(_interaction: unknown): Promise<void> {}
  },
  CommandInteraction: class MockCommandInteraction {
    id = "interaction-1";
    user = { id: "user-1", username: "testuser" };
    channel = { id: "channel-1" };
    guildId = null;
    options = {
      getSubcommand: () => null,
      getSubcommandGroup: () => null,
      getString: () => null,
    };
    async reply(_payload: unknown): Promise<void> {}
  },
  serializePayload: (payload: unknown) => payload,
}));

vi.mock("@buape/carbon/gateway", () => ({
  GatewayPlugin: mockState.MockGatewayPlugin,
  GatewayIntents: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    DirectMessages: 8,
  },
}));

describe("DiscordPlugin (carbon)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClients.length = 0;
    mockGateways.length = 0;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "app-123" }),
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    await Promise.all(activePlugins.splice(0).map((plugin) => plugin.disconnect().catch(() => {})));
    globalThis.fetch = originalFetch;
  });

  async function connectPlugin(plugin: DiscordPlugin): Promise<MockClient> {
    activePlugins.push(plugin);
    const connectPromise = plugin.connect();
    for (let i = 0; i < 20 && mockClients.length === 0; i += 1) {
      await Promise.resolve();
    }

    const client = mockClients.at(-1);
    expect(client).toBeDefined();
    if (!client) {
      throw new Error("client not created");
    }

    const readyListener = client.listeners.find((listener) => listener.type === "READY");
    expect(readyListener).toBeDefined();
    if (!readyListener) {
      throw new Error("ready listener not found");
    }

    await readyListener.handle(
      { user: { id: "bot-1", username: "MoziBot", discriminator: "1234" } },
      client,
    );
    await connectPromise;
    return client;
  }

  it("connects and becomes connected after READY", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    await connectPlugin(plugin);
    expect(plugin.getStatus()).toBe("connected");
  });

  it("disconnects gateway", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    await connectPlugin(plugin);

    await plugin.disconnect();

    expect(mockGateways[0]?.disconnect).toHaveBeenCalled();
    expect(plugin.getStatus()).toBe("disconnected");
  });

  it("sends text message via carbon rest", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    const client = await connectPlugin(plugin);

    const messageId = await plugin.send("channel-123", {
      text: "hello discord",
    });

    expect(messageId).toBe("sent-123");
    expect(client.rest.post).toHaveBeenCalledWith(
      expect.stringContaining("/channels/channel-123/messages"),
      expect.objectContaining({
        body: expect.objectContaining({
          content: "hello discord",
        }),
      }),
    );
  });

  it("chunks long messages and only replies on first chunk", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    const client = await connectPlugin(plugin);

    const longText = "a".repeat(2100);
    await plugin.send("channel-123", { text: longText, replyToId: "msg-1" });

    expect(client.rest.post).toHaveBeenCalledTimes(2);
    const firstBody = client.rest.post.mock.calls[0]?.[1]?.body as {
      content?: string;
      message_reference?: { message_id: string };
    };
    const secondBody = client.rest.post.mock.calls[1]?.[1]?.body as {
      content?: string;
      message_reference?: { message_id: string };
    };
    expect(firstBody.content?.length ?? 0).toBeLessThanOrEqual(2000);
    expect(secondBody.content?.length ?? 0).toBeLessThanOrEqual(2000);
    expect(firstBody.message_reference?.message_id).toBe("msg-1");
    expect(secondBody.message_reference).toBeUndefined();
  });

  it("sets silent flag on outbound messages", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    const client = await connectPlugin(plugin);

    await plugin.send("channel-123", { text: "hello", silent: true });

    const body = client.rest.post.mock.calls[0]?.[1]?.body as { flags?: number };
    expect(body.flags).toBe(1 << 12);
  });

  it("sets silent flag on all outbound chunks", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    const client = await connectPlugin(plugin);

    await plugin.send("channel-123", { text: "a".repeat(2100), silent: true });

    expect(client.rest.post.mock.calls.length).toBe(2);
    for (const call of client.rest.post.mock.calls) {
      const body = call?.[1]?.body as { flags?: number; content?: string };
      expect(body.flags).toBe(1 << 12);
      expect(body.content?.length ?? 0).toBeLessThanOrEqual(2000);
    }
  });

  it("sends buffer and path attachments", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    const client = await connectPlugin(plugin);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-discord-"));
    const filePath = path.join(tempDir, "note.txt");
    await fs.writeFile(filePath, "hello");

    await plugin.send("channel-123", {
      text: "files",
      media: [
        {
          type: "document",
          buffer: Buffer.from("buffer"),
          filename: "buffer.txt",
        },
        {
          type: "document",
          path: filePath,
        },
      ],
    });

    const body = client.rest.post.mock.calls[0]?.[1]?.body as {
      files?: Array<{ name?: string; data?: Blob }>;
      content?: string;
    };
    expect(body.content).toBe("files");
    expect(body.files?.length).toBe(2);
    expect(body.files?.[0]?.name).toBe("buffer.txt");
    expect(body.files?.[1]?.name).toBe("note.txt");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("sends different media types as attachments (photo, video, audio, animation, gif)", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    const client = await connectPlugin(plugin);

    // All media types should be sent as file attachments since Discord
    // doesn't have type-specific APIs like Telegram (no sendPhoto, sendVoice, etc.)
    await plugin.send("channel-123", {
      media: [
        {
          type: "photo",
          buffer: Buffer.from("photo-data"),
          filename: "photo.jpg",
          mimeType: "image/jpeg",
        },
        {
          type: "video",
          buffer: Buffer.from("video-data"),
          filename: "video.mp4",
          mimeType: "video/mp4",
        },
        {
          type: "audio",
          buffer: Buffer.from("audio-data"),
          filename: "audio.mp3",
          mimeType: "audio/mpeg",
        },
        {
          type: "animation",
          buffer: Buffer.from("anim-data"),
          filename: "animation.gif",
          mimeType: "image/gif",
        },
        {
          type: "gif",
          buffer: Buffer.from("gif-data"),
          filename: "image.gif",
          mimeType: "image/gif",
        },
        {
          type: "voice",
          buffer: Buffer.from("voice-data"),
          filename: "voice.ogg",
          mimeType: "audio/ogg",
        },
        {
          type: "video_note",
          buffer: Buffer.from("video-note"),
          filename: "video_note.mp4",
          mimeType: "video/mp4",
        },
      ],
    });

    const body = client.rest.post.mock.calls[0]?.[1]?.body as {
      files?: Array<{ name?: string; data?: Blob }>;
      content?: string;
    };
    expect(body.files?.length).toBe(7);
    expect(body.files?.[0]?.name).toBe("photo.jpg");
    expect(body.files?.[1]?.name).toBe("video.mp4");
    expect(body.files?.[2]?.name).toBe("audio.mp3");
    expect(body.files?.[3]?.name).toBe("animation.gif");
    expect(body.files?.[4]?.name).toBe("image.gif");
    expect(body.files?.[5]?.name).toBe("voice.ogg");
    expect(body.files?.[6]?.name).toBe("video_note.mp4");
  });

  it("uploads URL-based media as attachments when download succeeds", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    const client = await connectPlugin(plugin);

    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      if (input.includes("oauth2/applications/@me")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "app-123" }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name === "content-length" ? "10" : null) },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await plugin.send("channel-123", {
      text: "Check this out",
      media: [
        { type: "photo", url: "https://example.com/photo.jpg", filename: "photo.jpg" },
        { type: "video", url: "https://example.com/video.mp4", filename: "video.mp4" },
      ],
    });

    const body = client.rest.post.mock.calls[0]?.[1]?.body as {
      files?: Array<{ name?: string }>;
      content?: string;
    };
    expect(body.content).toContain("Check this out");
    expect(body.files?.length).toBe(2);
    expect(body.files?.[0]?.name).toBe("photo.jpg");
    expect(body.files?.[1]?.name).toBe("video.mp4");
  });

  it("falls back to text URL when URL media exceeds size guardrail", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    const client = await connectPlugin(plugin);

    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      if (input.includes("oauth2/applications/@me")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "app-123" }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name === "content-length" ? "60000000" : null) },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await plugin.send("channel-123", {
      text: "large file",
      media: [{ type: "document", url: "https://example.com/large.bin" }],
    });

    const body = client.rest.post.mock.calls[0]?.[1]?.body as {
      files?: Array<{ name?: string }>;
      content?: string;
    };
    expect(body.files).toBeUndefined();
    expect(body.content).toContain("large file");
    expect(body.content).toContain("https://example.com/large.bin");
  });

  it("falls back to text URL when URL media download fails", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    const client = await connectPlugin(plugin);

    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      if (input.includes("oauth2/applications/@me")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "app-123" }),
        };
      }
      return {
        ok: false,
        status: 500,
        headers: { get: () => null },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await plugin.send("channel-123", {
      text: "download failed",
      media: [{ type: "document", url: "https://example.com/fail.bin" }],
    });

    const body = client.rest.post.mock.calls[0]?.[1]?.body as {
      files?: Array<{ name?: string }>;
      content?: string;
    };
    expect(body.files).toBeUndefined();
    expect(body.content).toContain("download failed");
    expect(body.content).toContain("https://example.com/fail.bin");
  });

  it("attaches poll payload only on first outbound chunk", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    const client = await connectPlugin(plugin);

    await plugin.send("channel-123", {
      text: "a".repeat(2100),
      poll: {
        question: "Pick one",
        options: ["A", "B"],
        allowMultiselect: false,
        durationHours: 12,
      },
    });

    expect(client.rest.post).toHaveBeenCalledTimes(2);

    const firstBody = client.rest.post.mock.calls[0]?.[1]?.body as {
      poll?: {
        question?: { text?: string };
        answers?: Array<{ poll_media?: { text?: string } }>;
        allow_multiselect?: boolean;
        duration?: number;
      };
    };
    const secondBody = client.rest.post.mock.calls[1]?.[1]?.body as {
      poll?: {
        question?: { text?: string };
      };
    };

    expect(firstBody.poll?.question?.text).toBe("Pick one");
    expect(firstBody.poll?.answers?.length).toBe(2);
    expect(firstBody.poll?.answers?.[0]?.poll_media?.text).toBe("A");
    expect(firstBody.poll?.allow_multiselect).toBe(false);
    expect(firstBody.poll?.duration).toBe(12);
    expect(secondBody.poll).toBeUndefined();
  });

  it("sends outbound message via webhook when webhookUrl is set", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "webhook-1" }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const messageId = await plugin.send("ignored", {
      text: "hello webhook",
      webhookUrl: "https://discord.com/api/webhooks/1/token",
    });

    expect(messageId).toBe("webhook-1");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://discord.com/api/webhooks/1/token?wait=true"),
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/applications/@me"),
      expect.anything(),
    );
  });

  it("throws diagnosable error when webhook send fails", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    await expect(
      plugin.send("ignored", {
        text: "hello webhook",
        webhookUrl: "https://discord.com/api/webhooks/1/token",
      }),
    ).rejects.toThrow("Discord webhook send failed: 403");
  });

  it("limits component rows and buttons per row", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    const client = await connectPlugin(plugin);

    const rows = Array.from({ length: 6 }, (_rowUnused, rowIndex) =>
      Array.from({ length: 6 }, (_colUnused, colIndex) => ({
        text: `B${rowIndex}-${colIndex}`,
        callbackData: `/do-${rowIndex}-${colIndex}`,
      })),
    );

    await plugin.send("channel-123", {
      text: "buttons",
      buttons: rows,
    });

    const body = client.rest.post.mock.calls[0]?.[1]?.body as {
      components?: Array<{ components?: Array<{ custom_id?: string; label?: string }> }>;
    };

    expect(body.components?.length).toBe(5);
    for (const row of body.components ?? []) {
      expect(row.components?.length).toBe(5);
    }
    expect(body.components?.[0]?.components?.[0]?.custom_id).toBe("/do-0-0");
  });

  it("uses caption as fallback text when no text provided", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    const client = await connectPlugin(plugin);

    // No text, but has caption in media
    await plugin.send("channel-123", {
      media: [
        {
          type: "photo",
          buffer: Buffer.from("photo"),
          filename: "photo.jpg",
          caption: "A beautiful sunset",
        },
      ],
    });

    const body = client.rest.post.mock.calls[0]?.[1]?.body as {
      files?: Array<{ name?: string }>;
      content?: string;
    };
    expect(body.content).toBe("A beautiful sunset");
    expect(body.files?.length).toBe(1);
  });

  it("maps inbound attachments to correct media types", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    const client = await connectPlugin(plugin);

    const listener = client.listeners.find((item) => item.type === "MESSAGE_CREATE");
    expect(listener).toBeDefined();
    if (!listener) {
      throw new Error("message listener not found");
    }

    let receivedMedia: Array<{ type: string; mimeType?: string }> | undefined;
    plugin.on("message", (msg) => {
      receivedMedia = (msg as { media?: Array<{ type: string; mimeType?: string }> }).media;
    });

    await listener.handle(
      {
        author: { id: "user-1", username: "alice", bot: false },
        message: {
          id: "msg-123",
          channelId: "chan-1",
          content: "hello",
          attachments: [
            {
              id: "1",
              filename: "photo.jpg",
              content_type: "image/jpeg",
              size: 1000,
              url: "https://example.com/photo.jpg",
              proxy_url: "https://example.com/proxy/photo.jpg",
            },
            {
              id: "2",
              filename: "video.mp4",
              content_type: "video/mp4",
              size: 5000,
              url: "https://example.com/video.mp4",
              proxy_url: "https://example.com/proxy/video.mp4",
            },
            {
              id: "3",
              filename: "audio.mp3",
              content_type: "audio/mpeg",
              size: 2000,
              url: "https://example.com/audio.mp3",
              proxy_url: "https://example.com/proxy/audio.mp3",
            },
            {
              id: "4",
              filename: "doc.pdf",
              content_type: "application/pdf",
              size: 3000,
              url: "https://example.com/doc.pdf",
              proxy_url: "https://example.com/proxy/doc.pdf",
            },
            {
              id: "5",
              filename: "unknown",
              size: 100,
              url: "https://example.com/unknown",
              proxy_url: "https://example.com/proxy/unknown",
            },
          ],
          timestamp: new Date().toISOString(),
        },
      },
      client,
    );

    expect(receivedMedia).toBeDefined();
    const media = receivedMedia;
    if (!media) {
      throw new Error("Expected normalized media attachments");
    }
    expect(media.length).toBe(5);
    expect(media[0]?.type).toBe("photo");
    expect(media[1]?.type).toBe("video");
    expect(media[2]?.type).toBe("audio");
    expect(media[3]?.type).toBe("document");
    expect(media[4]?.type).toBe("document"); // unknown content type defaults to document
  });

  it("normalizes slash interactions to parity text semantics", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    const client = await connectPlugin(plugin);

    const cases: Array<{ cmd: string; option?: string; expectedText: string }> = [
      { cmd: "help", expectedText: "/help" },
      { cmd: "status", expectedText: "/status" },
      { cmd: "models", expectedText: "/models" },
      { cmd: "skills", expectedText: "/skills" },
      { cmd: "new", expectedText: "/new" },
      { cmd: "reset", expectedText: "/reset" },
      { cmd: "stop", expectedText: "/stop" },
      { cmd: "switch", option: "openai/gpt-5", expectedText: "/switch openai/gpt-5" },
    ];

    const received: Array<{ text: string }> = [];
    plugin.on("message", (msg) => {
      received.push(msg as { text: string });
    });

    for (const c of cases) {
      const slash = client.commands.find(
        (command) =>
          (
            command as {
              name?: string;
              run: (interaction: {
                options: { getString: (name: string) => string | null };
                reply: (payload: unknown) => Promise<void>;
              }) => Promise<void>;
            }
          ).name === c.cmd,
      ) as {
        run: (interaction: {
          options: { getString: (name: string) => string | null };
          reply: (payload: unknown) => Promise<void>;
        }) => Promise<void>;
      };

      expect(slash).toBeDefined();
      await slash.run({
        id: `i-${c.cmd}`,
        guildId: null,
        user: { id: "u-1", username: "alice" },
        channel: { id: "chan-1" },
        options: {
          getString: (name: string) => (name === "model" ? (c.option ?? null) : null),
        },
        reply: vi.fn(async () => {}),
      } as unknown as {
        options: { getString: (name: string) => string | null };
        reply: (payload: unknown) => Promise<void>;
      });
    }

    expect(received.map((m) => m.text)).toEqual(cases.map((c) => c.expectedText));
    expect(received.map((m) => parseCommand(m.text))).toEqual(
      cases.map((c) => parseCommand(c.expectedText)),
    );
  });

  it("handles inbound message", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    const client = await connectPlugin(plugin);

    const listener = client.listeners.find((item) => item.type === "MESSAGE_CREATE");
    expect(listener).toBeDefined();
    if (!listener) {
      throw new Error("message listener not found");
    }

    let received: unknown;
    plugin.on("message", (msg) => {
      received = msg;
    });

    await listener.handle(
      {
        guild_id: "guild-1",
        author: { id: "user-1", username: "alice", bot: false },
        message: {
          id: "msg-123",
          channelId: "chan-1",
          content: "hello bot",
          attachments: [],
          messageReference: undefined,
          timestamp: new Date().toISOString(),
        },
      },
      client,
    );

    expect(received).toBeDefined();
    const msg = received as {
      id: string;
      text: string;
      peerType: string;
      senderName?: string;
      peerId: string;
    };
    expect(msg.id).toBe("msg-123");
    expect(msg.text).toBe("hello bot");
    expect(msg.peerType).toBe("group");
    expect(msg.senderName).toBe("alice");
    expect(msg.peerId).toBe("chan-1");
  });

  it("maps inbound discord thread channel into canonical threadId", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    const client = await connectPlugin(plugin);

    const listener = client.listeners.find((item) => item.type === "MESSAGE_CREATE");
    expect(listener).toBeDefined();
    if (!listener) {
      throw new Error("message listener not found");
    }

    let received: unknown;
    plugin.on("message", (msg) => {
      received = msg;
    });

    await listener.handle(
      {
        guild_id: "guild-1",
        author: { id: "user-1", username: "alice", bot: false },
        message: {
          id: "msg-thread-1",
          channelId: "thread-999",
          content: "inside thread",
          attachments: [],
          messageReference: { message_id: "parent-msg-1" },
          channel: { isThread: () => true },
          timestamp: new Date().toISOString(),
        },
      },
      client,
    );

    const msg = received as { threadId?: string; replyToId?: string; peerId?: string };
    expect(msg.threadId).toBe("thread-999");
    expect(msg.replyToId).toBe("parent-msg-1");
    expect(msg.peerId).toBe("thread-999");
  });

  it("ignores bot messages", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    const client = await connectPlugin(plugin);

    const listener = client.listeners.find((item) => item.type === "MESSAGE_CREATE");
    expect(listener).toBeDefined();
    if (!listener) {
      throw new Error("message listener not found");
    }

    let received = false;
    plugin.on("message", () => {
      received = true;
    });

    await listener.handle(
      {
        author: { id: "bot-1", username: "bot", bot: true },
        message: {
          id: "msg-123",
          channelId: "chan-1",
          content: "ignore me",
          attachments: [],
          timestamp: new Date().toISOString(),
        },
      },
      client,
    );

    expect(received).toBe(false);
  });

  it("respects channel whitelist", async () => {
    const plugin = new DiscordPlugin({
      botToken: "test-token",
      allowedChannels: ["allowed-1"],
    });
    const client = await connectPlugin(plugin);

    const listener = client.listeners.find((item) => item.type === "MESSAGE_CREATE");
    expect(listener).toBeDefined();
    if (!listener) {
      throw new Error("message listener not found");
    }

    let received = false;
    plugin.on("message", () => {
      received = true;
    });

    await listener.handle(
      {
        author: { id: "user-1", username: "alice", bot: false },
        message: {
          id: "msg-1",
          channelId: "random",
          content: "hello",
          attachments: [],
          timestamp: new Date().toISOString(),
        },
      },
      client,
    );
    expect(received).toBe(false);

    await listener.handle(
      {
        author: { id: "user-1", username: "alice", bot: false },
        message: {
          id: "msg-2",
          channelId: "allowed-1",
          content: "hello",
          attachments: [],
          timestamp: new Date().toISOString(),
        },
      },
      client,
    );
    expect(received).toBe(true);
  });

  it("enforces dm allowlist when dmPolicy=allowlist", async () => {
    const plugin = new DiscordPlugin({
      botToken: "test-token",
      dmPolicy: "allowlist",
      allowFrom: ["user-1"],
    });
    const client = await connectPlugin(plugin);

    const listener = client.listeners.find((item) => item.type === "MESSAGE_CREATE");
    expect(listener).toBeDefined();
    if (!listener) {
      throw new Error("message listener not found");
    }

    let received = false;
    plugin.on("message", () => {
      received = true;
    });

    await listener.handle(
      {
        author: { id: "user-2", username: "bob", bot: false },
        message: {
          id: "msg-1",
          channelId: "dm-1",
          content: "hello",
          attachments: [],
          timestamp: new Date().toISOString(),
        },
      },
      client,
    );
    expect(received).toBe(false);

    await listener.handle(
      {
        author: { id: "user-1", username: "alice", bot: false },
        message: {
          id: "msg-2",
          channelId: "dm-1",
          content: "hello",
          attachments: [],
          timestamp: new Date().toISOString(),
        },
      },
      client,
    );
    expect(received).toBe(true);
  });

  it("enforces group policy allowlist", async () => {
    const plugin = new DiscordPlugin({
      botToken: "test-token",
      groupPolicy: "allowlist",
      allowFrom: ["user-1"],
    });
    const client = await connectPlugin(plugin);

    const listener = client.listeners.find((item) => item.type === "MESSAGE_CREATE");
    expect(listener).toBeDefined();
    if (!listener) {
      throw new Error("message listener not found");
    }

    let received = false;
    plugin.on("message", () => {
      received = true;
    });

    await listener.handle(
      {
        guild_id: "guild-1",
        author: { id: "user-2", username: "bob", bot: false },
        message: {
          id: "msg-1",
          channelId: "chan-1",
          content: "hello",
          attachments: [],
          timestamp: new Date().toISOString(),
        },
      },
      client,
    );
    expect(received).toBe(false);

    await listener.handle(
      {
        guild_id: "guild-1",
        author: { id: "user-1", username: "alice", bot: false },
        message: {
          id: "msg-2",
          channelId: "chan-1",
          content: "hello",
          attachments: [],
          timestamp: new Date().toISOString(),
        },
      },
      client,
    );
    expect(received).toBe(true);
  });

  it("enforces role allowlist per guild", async () => {
    const plugin = new DiscordPlugin({
      botToken: "test-token",
      guilds: {
        "guild-1": { allowRoles: ["role-1"] },
      },
    });
    const client = await connectPlugin(plugin);

    const listener = client.listeners.find((item) => item.type === "MESSAGE_CREATE");
    expect(listener).toBeDefined();
    if (!listener) {
      throw new Error("message listener not found");
    }

    let received = false;
    plugin.on("message", () => {
      received = true;
    });

    await listener.handle(
      {
        guild_id: "guild-1",
        rawMember: { roles: ["role-2"] },
        author: { id: "user-1", username: "alice", bot: false },
        message: {
          id: "msg-1",
          channelId: "chan-1",
          content: "hello",
          attachments: [],
          timestamp: new Date().toISOString(),
        },
      },
      client,
    );
    expect(received).toBe(false);

    await listener.handle(
      {
        guild_id: "guild-1",
        rawMember: { roles: ["role-1"] },
        author: { id: "user-1", username: "alice", bot: false },
        message: {
          id: "msg-2",
          channelId: "chan-1",
          content: "hello",
          attachments: [],
          timestamp: new Date().toISOString(),
        },
      },
      client,
    );
    expect(received).toBe(true);
  });

  it("enforces requireMention per guild", async () => {
    const plugin = new DiscordPlugin({
      botToken: "test-token",
      guilds: {
        "guild-1": { requireMention: true },
      },
    });
    const client = await connectPlugin(plugin);

    const listener = client.listeners.find((item) => item.type === "MESSAGE_CREATE");
    expect(listener).toBeDefined();
    if (!listener) {
      throw new Error("message listener not found");
    }

    let received = false;
    plugin.on("message", () => {
      received = true;
    });

    await listener.handle(
      {
        guild_id: "guild-1",
        author: { id: "user-1", username: "alice", bot: false },
        message: {
          id: "msg-1",
          channelId: "chan-1",
          content: "hello",
          attachments: [],
          mentions: [],
          timestamp: new Date().toISOString(),
        },
      },
      client,
    );
    expect(received).toBe(false);

    await listener.handle(
      {
        guild_id: "guild-1",
        author: { id: "user-1", username: "alice", bot: false },
        message: {
          id: "msg-2",
          channelId: "chan-1",
          content: "hello <@bot-1>",
          attachments: [],
          mentions: [{ id: "bot-1" }],
          timestamp: new Date().toISOString(),
        },
      },
      client,
    );
    expect(received).toBe(true);
  });

  it("disables reconnect after auth failure to prevent connection storm", async () => {
    const plugin = new DiscordPlugin({ botToken: "test-token" });
    await connectPlugin(plugin);

    const internal = plugin as unknown as {
      handleAuthFailure: (source: string, error: unknown) => void;
    };
    internal.handleAuthFailure("test", new Error("Fatal Gateway error: 4004"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockGateways[0]?.disconnect).toHaveBeenCalled();
    expect(plugin.getStatus()).toBe("error");
    await expect(plugin.connect()).rejects.toThrow("Discord authentication failed");
  });

  it("sets status reaction and removes previous", async () => {
    const plugin = new DiscordPlugin({
      botToken: "test-token",
      statusReactions: { enabled: true },
    });
    const client = await connectPlugin(plugin);

    await plugin.setStatusReaction?.("chan-1", "msg-1", "thinking");

    expect(client.rest.put).toHaveBeenCalledWith(
      expect.stringContaining(
        `/channels/chan-1/messages/msg-1/reactions/${encodeURIComponent("🤔")}`,
      ),
    );

    await plugin.setStatusReaction?.("chan-1", "msg-1", "tool");

    expect(client.rest.delete).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent("🤔")),
    );
  });

  it("encodes custom emoji identifiers", async () => {
    const plugin = new DiscordPlugin({
      botToken: "test-token",
      statusReactions: { enabled: true, emojis: { thinking: "<:party_blob:123>" } },
    });
    const client = await connectPlugin(plugin);

    await plugin.setStatusReaction?.("chan-2", "msg-2", "thinking");

    expect(client.rest.put).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent("party_blob:123")),
    );
  });

  it("skips status reaction when disabled", async () => {
    const plugin = new DiscordPlugin({
      botToken: "test-token",
      statusReactions: { enabled: false },
    });
    const client = await connectPlugin(plugin);

    await plugin.setStatusReaction?.("chan-3", "msg-3", "thinking");

    expect(client.rest.put).not.toHaveBeenCalled();
    expect(client.rest.delete).not.toHaveBeenCalled();
  });

  describe("createThread", () => {
    it("creates a forum post when channel is a forum", async () => {
      const plugin = new DiscordPlugin({ botToken: "test-token" });
      const client = await connectPlugin(plugin);

      // Mock channel GET to return forum type
      client.rest.get = vi.fn().mockResolvedValue({ type: 15, id: "forum-1" }); // 15 = GuildForum
      client.rest.post = vi.fn().mockResolvedValue({ id: "forum-post-123" });

      const threadId = await plugin.createThread("forum-1", "New Forum Post");

      expect(threadId).toBe("forum-post-123");
      expect(client.rest.get).toHaveBeenCalledWith(expect.stringContaining("/channels/forum-1"));
      expect(client.rest.post).toHaveBeenCalledWith(
        expect.stringContaining("/channels/forum-1/messages"),
        expect.objectContaining({
          body: expect.objectContaining({
            name: "New Forum Post",
            content: " ",
          }),
        }),
      );
    });

    it("creates a private thread from a message", async () => {
      const plugin = new DiscordPlugin({ botToken: "test-token" });
      const client = await connectPlugin(plugin);

      // Mock channel GET to return text channel type
      client.rest.get = vi.fn().mockResolvedValue({ type: 0, id: "text-1" }); // 0 = GUILD_TEXT
      client.rest.post = vi.fn().mockResolvedValue({ id: "thread-456" });

      const threadId = await plugin.createThread("text-1", "My Thread", "msg-789");

      expect(threadId).toBe("thread-456");
      expect(client.rest.post).toHaveBeenCalledWith(
        expect.stringContaining("/channels/text-1"),
        expect.objectContaining({
          body: expect.objectContaining({
            name: "My Thread",
            type: 12, // PrivateThread
            message_id: "msg-789",
          }),
        }),
      );
    });

    it("creates a public thread when no messageId provided", async () => {
      const plugin = new DiscordPlugin({ botToken: "test-token" });
      const client = await connectPlugin(plugin);

      client.rest.get = vi.fn().mockResolvedValue({ type: 0, id: "text-1" });
      client.rest.post = vi.fn().mockResolvedValue({ id: "public-thread-789" });

      const threadId = await plugin.createThread("text-1", "Public Thread");

      expect(threadId).toBe("public-thread-789");
      expect(client.rest.post).toHaveBeenCalledWith(
        expect.stringContaining("/channels/text-1"),
        expect.objectContaining({
          body: expect.objectContaining({
            name: "Public Thread",
            type: 11, // PublicThread
          }),
        }),
      );
    });

    it("throws when client not connected", async () => {
      const plugin = new DiscordPlugin({ botToken: "test-token" });

      await expect(plugin.createThread("chan-1", "Test")).rejects.toThrow(
        "Discord client is not connected",
      );
    });
  });

  describe("diagnosePermissionError", () => {
    it("diagnoses missing permissions error (50013)", () => {
      const error = new Error("Discord API error: 50013: Missing permissions");
      const result = DiscordPlugin.diagnosePermissionError(error, "send message");

      expect(result.name).toBe("DiscordPermissionError");
      expect(result.message).toContain("Missing permissions");
      expect(result.message.toLowerCase()).toContain("send messages");
      expect(result.message).toContain("Create Public/Private Threads");
    });

    it("diagnoses missing access error (50001)", () => {
      const error = new Error("Discord API error: 50001: Missing access");
      const result = DiscordPlugin.diagnosePermissionError(error, "edit message");

      expect(result.name).toBe("DiscordAccessError");
      expect(result.message).toContain("Missing access");
      expect(result.message.toLowerCase()).toContain("bot is not in the server");
    });

    it("diagnoses thread quota error (30033)", () => {
      const error = new Error("Discord API error: 30033: Thread quota exceeded");
      const result = DiscordPlugin.diagnosePermissionError(error);

      expect(result.name).toBe("DiscordThreadQuotaError");
      expect(result.message).toContain("Thread creation quota exceeded");
      expect(result.message).toContain("forum posts");
    });

    it("diagnoses unknown channel error (40004)", () => {
      const error = new Error("Discord API error: 40004: Unknown channel");
      const result = DiscordPlugin.diagnosePermissionError(error, "create thread");

      expect(result.name).toBe("DiscordChannelError");
      expect(result.message).toContain("channel does not exist");
    });

    it("returns original error for unknown Discord errors", () => {
      const error = new Error("Some unrelated error");
      const result = DiscordPlugin.diagnosePermissionError(error);

      expect(result).toBe(error);
    });

    it("handles non-Error inputs", () => {
      const result = DiscordPlugin.diagnosePermissionError("string error");
      expect(result.message).toContain("string error");
    });
  });
});
