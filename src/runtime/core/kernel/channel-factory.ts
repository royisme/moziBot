import type { RuntimeQueueItem } from "../../../storage/db";
import type { ChannelPlugin } from "../../adapters/channels/plugin";
import type { OutboundMessage } from "../../adapters/channels/types";
import type { RuntimeDeliveryReceipt, RuntimeEgress } from "../contracts";

export function createRuntimeChannel(params: {
  queueItem: RuntimeQueueItem;
  envelopeId: string;
  egress: RuntimeEgress;
}): ChannelPlugin {
  const buildReceipt = (peerId: string): RuntimeDeliveryReceipt => ({
    queueItemId: params.queueItem.id,
    envelopeId: params.envelopeId,
    sessionKey: params.queueItem.session_key,
    channelId: params.queueItem.channel_id,
    peerId,
    attempt: params.queueItem.attempts,
    status: "running",
  });

  const runtimeChannel = {
    id: params.queueItem.channel_id,
    name: "runtime-egress",
    connect: async () => {},
    disconnect: async () => {},
    getStatus: () => "connected" as const,
    isConnected: () => true,
    send: async (peerId: string, outbound: OutboundMessage) => {
      return await params.egress.deliver(outbound, buildReceipt(peerId));
    },
    beginTyping: async (peerId: string) => {
      if (!params.egress.beginTyping) {
        return undefined;
      }
      return await params.egress.beginTyping(buildReceipt(peerId));
    },
    on: () => runtimeChannel,
    once: () => runtimeChannel,
    off: () => runtimeChannel,
    emit: () => true,
    removeAllListeners: () => runtimeChannel,
  } as unknown as ChannelPlugin;

  return runtimeChannel;
}
