import type { ChannelRegistry } from "../adapters/channels/registry";
import type { OutboundMessage } from "../adapters/channels/types";
import type { RuntimeDeliveryReceipt, RuntimeEgress } from "./contracts";

export class ChannelRuntimeEgress implements RuntimeEgress {
  constructor(private readonly channels: ChannelRegistry) {}

  async deliver(outbound: OutboundMessage, receipt: RuntimeDeliveryReceipt): Promise<string> {
    const channel = this.channels.get(receipt.channelId);
    if (!channel) {
      throw new Error(`Channel adapter not found: ${receipt.channelId}`);
    }
    return await channel.send(receipt.peerId, outbound);
  }

  async beginTyping(receipt: RuntimeDeliveryReceipt): Promise<(() => Promise<void> | void) | void> {
    const channel = this.channels.get(receipt.channelId);
    if (!channel || typeof channel.beginTyping !== "function") {
      return undefined;
    }
    return await channel.beginTyping(receipt.peerId);
  }
}
