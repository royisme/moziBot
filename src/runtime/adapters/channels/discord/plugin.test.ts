import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordPlugin } from "./plugin";

type MockClient = {
  listeners: Array<{
    type?: string;
    handle: (data: unknown, client: MockClient) => Promise<void>;
  }>;
  rest: {
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
      rest: {
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
});
