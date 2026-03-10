import type { RuntimeQueueItem } from "../../../storage/db";
import type { ChannelPlugin } from "../../adapters/channels/plugin";
import type {
  ChannelActionQueryContext,
  ChannelActionSpec,
  ChannelActionName,
  ChannelCapabilities,
  OutboundMessage,
  StatusReaction,
  StatusReactionPayload,
} from "../../adapters/channels/types";
import type { RuntimeDeliveryReceipt, RuntimeEgress } from "../contracts";

export function createRuntimeChannel(params: {
  queueItem: RuntimeQueueItem;
  envelopeId: string;
  egress: RuntimeEgress;
  getChannelCapabilities?: (channelId: string) => ChannelCapabilities;
  getChannelListActions?: (
    channelId: string,
    context?: ChannelActionQueryContext,
  ) => ChannelActionSpec[];
}): ChannelPlugin {
  const channelId = params.queueItem.channel_id;

  const buildReceipt = (peerId: string): RuntimeDeliveryReceipt => ({
    queueItemId: params.queueItem.id,
    envelopeId: params.envelopeId,
    sessionKey: params.queueItem.session_key,
    channelId: params.queueItem.channel_id,
    peerId,
    attempt: params.queueItem.attempts,
    status: "running",
  });

  // Default implementations that use fallback capabilities
  const defaultCapabilities: ChannelCapabilities = {
    media: true,
    polls: false,
    reactions: true,
    threads: true,
    editMessage: true,
    deleteMessage: true,
    implicitCurrentTarget: true,
    supportedActions: ["send_text", "send_media", "reply"],
  };

  const defaultListActions = (context?: ChannelActionQueryContext): ChannelActionSpec[] => {
    const supported = new Set(defaultCapabilities.supportedActions);
    return [
      {
        name: "send_text" as ChannelActionName,
        enabled: supported.has("send_text"),
        description: "Send text to the current conversation.",
      },
      {
        name: "send_media" as ChannelActionName,
        enabled: supported.has("send_media"),
        description: "Send media attachments to the current conversation.",
      },
      {
        name: "reply" as ChannelActionName,
        enabled: supported.has("reply"),
        description: "Reply in the current conversation or thread.",
      },
    ].filter((spec) => spec.enabled || context !== undefined);
  };

  const getCapabilities = (): ChannelCapabilities => {
    if (params.getChannelCapabilities) {
      return params.getChannelCapabilities(channelId);
    }
    return defaultCapabilities;
  };

  const listActions = (context?: ChannelActionQueryContext): ChannelActionSpec[] => {
    if (params.getChannelListActions) {
      return params.getChannelListActions(channelId, context);
    }
    return defaultListActions(context);
  };

  const runtimeChannel = {
    id: params.queueItem.channel_id,
    name: "runtime-egress",
    connect: async () => {},
    disconnect: async () => {},
    getCapabilities,
    listActions,
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
    setStatusReaction: async (
      peerId: string,
      messageId: string,
      status: StatusReaction,
      payload?: StatusReactionPayload,
    ) => {
      if (!params.egress.setStatusReaction) {
        return;
      }
      await params.egress.setStatusReaction({
        receipt: buildReceipt(peerId),
        messageId,
        status,
        payload,
      });
    },
    on: () => runtimeChannel,
    once: () => runtimeChannel,
    off: () => runtimeChannel,
    emit: () => true,
    removeAllListeners: () => runtimeChannel,
  } as unknown as ChannelPlugin;

  return runtimeChannel;
}
