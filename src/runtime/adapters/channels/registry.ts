import type { ChannelPlugin } from "./plugin";
import type { InboundMessage } from "./types";
import { logger } from "../../../logger";

export class ChannelRegistry {
  private plugins: Map<string, ChannelPlugin> = new Map();
  private messageHandler?: (msg: InboundMessage) => void;

  register(plugin: ChannelPlugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin with id ${plugin.id} already registered`);
    }
    this.plugins.set(plugin.id, plugin);

    plugin.on("message", (msg: InboundMessage) => {
      if (this.messageHandler) {
        this.messageHandler(msg);
      }
    });

    plugin.on("error", (error: Error) => {
      logger.error({ err: error, channelId: plugin.id }, "Channel plugin error");
    });

    logger.info({ channelId: plugin.id, name: plugin.name }, "Channel plugin registered");
  }

  unregister(id: string): void {
    const plugin = this.plugins.get(id);
    if (plugin) {
      plugin.removeAllListeners("message");
      plugin.removeAllListeners("error");
      this.plugins.delete(id);
      logger.info({ channelId: id }, "Channel plugin unregistered");
    }
  }

  get(id: string): ChannelPlugin | undefined {
    return this.plugins.get(id);
  }

  list(): ChannelPlugin[] {
    return Array.from(this.plugins.values());
  }

  setMessageHandler(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  async connectAll(): Promise<void> {
    const results = await Promise.allSettled(this.list().map((plugin) => plugin.connect()));

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const plugin = this.list()[i];
      if (result.status === "rejected") {
        logger.error(
          { err: result.reason, channelId: plugin.id },
          "Failed to connect channel plugin",
        );
      }
    }
  }

  async disconnectAll(): Promise<void> {
    const results = await Promise.allSettled(this.list().map((plugin) => plugin.disconnect()));

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const plugin = this.list()[i];
      if (result.status === "rejected") {
        logger.error(
          { err: result.reason, channelId: plugin.id },
          "Failed to disconnect channel plugin",
        );
      }
    }
  }
}
