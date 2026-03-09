import {
  buildChannelActionEnvelope,
  lowerChannelActionEnvelopeToOutbound,
} from "../runtime/adapters/channels/action-dispatch";
import type {
  ChannelActionEnvelope,
  CurrentChannelContext,
  OutboundMessage,
} from "../runtime/adapters/channels/types";
import type { DeliveryPlan } from "./capabilities";

export function planOutboundByNegotiation(params: {
  channelId: string;
  text: string;
  inboundPlan?: DeliveryPlan | null;
  currentChannel: CurrentChannelContext;
  media?: OutboundMessage["media"];
  buttons?: OutboundMessage["buttons"];
  silent?: boolean;
}): ChannelActionEnvelope {
  return buildChannelActionEnvelope(params);
}

export function lowerPlannedOutboundToMessages(params: {
  envelope: ChannelActionEnvelope;
  currentChannel: CurrentChannelContext;
  traceId?: string;
}): { peerId: string; messages: OutboundMessage[] } {
  return lowerChannelActionEnvelopeToOutbound(params);
}
