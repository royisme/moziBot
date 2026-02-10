import { describe, expect, it, vi } from "vitest";
import type { InboundMessage, OutboundMessage } from "./types";
import { BaseChannelPlugin } from "./plugin";
import { ChannelRegistry } from "./registry";

// Mock logger
vi.mock("../../../logger", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

class MockPlugin extends BaseChannelPlugin {
  readonly id: string;
  readonly name: string;

  constructor(id: string, name: string) {
    super();
    this.id = id;
    this.name = name;
  }

  async connect(): Promise<void> {
    this.setStatus("connected");
  }

  async disconnect(): Promise<void> {
    this.setStatus("disconnected");
  }

  async send(_peerId: string, _message: OutboundMessage): Promise<string> {
    return "msg_id";
  }

  // Exposed for testing
  testEmitMessage(msg: InboundMessage) {
    this.emitMessage(msg);
  }
}

describe("ChannelRegistry", () => {
  it("should register and unregister plugins", () => {
    const registry = new ChannelRegistry();
    const plugin = new MockPlugin("test", "Test Plugin");

    registry.register(plugin);
    expect(registry.get("test")).toBe(plugin);
    expect(registry.list()).toContain(plugin);

    registry.unregister("test");
    expect(registry.get("test")).toBeUndefined();
    expect(registry.list()).not.toContain(plugin);
  });

  it("should route messages to the handler", () => {
    const registry = new ChannelRegistry();
    const plugin = new MockPlugin("test", "Test Plugin");
    const handler = vi.fn();

    registry.register(plugin);
    registry.setMessageHandler(handler);

    const msg: InboundMessage = {
      id: "1",
      channel: "test",
      peerId: "chat1",
      peerType: "dm",
      senderId: "user1",
      text: "hello",
      timestamp: new Date(),
      raw: {},
    };

    plugin.testEmitMessage(msg);
    expect(handler).toHaveBeenCalledWith(msg);
  });

  it("should connect and disconnect all plugins", async () => {
    const registry = new ChannelRegistry();
    const p1 = new MockPlugin("p1", "Plugin 1");
    const p2 = new MockPlugin("p2", "Plugin 2");

    registry.register(p1);
    registry.register(p2);

    await registry.connectAll();
    expect(p1.getStatus()).toBe("connected");
    expect(p2.getStatus()).toBe("connected");

    await registry.disconnectAll();
    expect(p1.getStatus()).toBe("disconnected");
    expect(p2.getStatus()).toBe("disconnected");
  });

  it("should track plugin status", async () => {
    const plugin = new MockPlugin("test", "Test");
    const statusSpy = vi.fn();
    plugin.on("status", statusSpy);

    expect(plugin.getStatus()).toBe("disconnected");
    expect(plugin.isConnected()).toBe(false);

    await plugin.connect();
    expect(plugin.getStatus()).toBe("connected");
    expect(plugin.isConnected()).toBe(true);
    expect(statusSpy).toHaveBeenCalledWith("connected");
  });
});
