import type { DeliveryPlan } from "../../../../multimodal/capabilities";
import {
  lowerPlannedOutboundToMessages,
  planOutboundByNegotiation,
} from "../../../../multimodal/outbound";
import type {
  ChannelActionEnvelope,
  CurrentChannelContext,
  OutboundMessage,
} from "../../../adapters/channels/types";
import { renderAssistantReply } from "../../reply-utils";
import type { DeliveryContext } from "../../routing/types";
import { buildCurrentChannelContextFromDelivery } from "./current-channel-context";

/**
 * Reply Dispatcher and Outbound Delivery Service
 *
 * Manages the final delivery of messages to channels, including multimodal
 * negotiation and streaming finalization.
 */

export interface ChannelDispatcherShape {
  readonly id: string;
  readonly send: (peerId: string, message: OutboundMessage) => Promise<string>;
  readonly getCapabilities: () => CurrentChannelContext["capabilities"];
  readonly listActions?: (
    context?: import("../../../adapters/channels/types").ChannelActionQueryContext,
  ) => import("../../../adapters/channels/types").ChannelActionSpec[];
}

export function buildReplyOutbound(params: {
  channelId: string;
  currentChannel: CurrentChannelContext;
  replyText?: string;
  inboundPlan?: DeliveryPlan | null;
  showThinking?: boolean;
  media?: OutboundMessage["media"];
  buttons?: OutboundMessage["buttons"];
  silent?: boolean;
}): ChannelActionEnvelope {
  const {
    channelId,
    currentChannel,
    replyText,
    inboundPlan,
    showThinking = false,
    media,
    buttons,
    silent,
  } = params;

  const renderedText = replyText
    ? renderAssistantReply(replyText, {
        showThinking,
      })
    : "";

  const text = renderedText || "(no response)";

  return planOutboundByNegotiation({
    channelId,
    text,
    inboundPlan,
    currentChannel,
    media,
    buttons,
    silent,
  });
}

export async function dispatchReply(params: {
  channel: ChannelDispatcherShape;
  delivery: DeliveryContext;
  replyText?: string;
  inboundPlan?: DeliveryPlan | null;
  showThinking?: boolean;
  media?: OutboundMessage["media"];
  buttons?: OutboundMessage["buttons"];
  silent?: boolean;
}): Promise<string> {
  const { channel, delivery, replyText, inboundPlan, showThinking, media, buttons, silent } =
    params;
  const currentChannel = buildCurrentChannelContextFromDelivery({
    plugin: channel,
    delivery,
  });
  const outbound = buildReplyOutbound({
    channelId: delivery.route.channelId,
    currentChannel,
    replyText,
    inboundPlan,
    showThinking,
    media,
    buttons,
    silent,
  });
  const lowered = lowerPlannedOutboundToMessages({
    envelope: outbound,
    currentChannel,
    traceId: delivery.traceId,
  });

  let lastId = "";
  for (const message of lowered.messages) {
    lastId = await channel.send(lowered.peerId, message);
  }
  return lastId;
}
