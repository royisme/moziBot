import type { DeliveryPlan } from "../../../../multimodal/capabilities";
import { planOutboundByNegotiation } from "../../../../multimodal/outbound";
import type { OutboundMessage } from "../../../adapters/channels/types";
import { routeContextToOutboundMessage } from "../../routing/route-context";
import type { DeliveryContext } from "../../routing/types";
import { renderAssistantReply } from "../../reply-utils";

/**
 * Reply Dispatcher and Outbound Delivery Service
 *
 * Manages the final delivery of messages to channels, including multimodal
 * negotiation and streaming finalization.
 */

export interface ChannelDispatcherShape {
  readonly id: string;
  readonly send: (peerId: string, message: OutboundMessage) => Promise<string>;
}

export function buildReplyOutbound(params: {
  channelId: string;
  replyText?: string;
  inboundPlan?: DeliveryPlan | null;
  showThinking?: boolean;
}): OutboundMessage {
  const { channelId, replyText, inboundPlan, showThinking = false } = params;

  const renderedText = replyText
    ? renderAssistantReply(replyText, {
        showThinking,
      })
    : "";

  // Parity: use "(no response)" fallback for empty rendered text
  const text = renderedText || "(no response)";

  // Parity: delegate to multimodal negotiation logic
  return planOutboundByNegotiation({
    channelId,
    text,
    inboundPlan,
  });
}

export async function dispatchReply(params: {
  channel: ChannelDispatcherShape;
  delivery: DeliveryContext;
  replyText?: string;
  inboundPlan?: DeliveryPlan | null;
  showThinking?: boolean;
}): Promise<string> {
  const { channel, delivery, replyText, inboundPlan, showThinking } = params;
  const outbound = buildReplyOutbound({
    channelId: delivery.route.channelId,
    replyText,
    inboundPlan,
    showThinking,
  });
  const flattened = routeContextToOutboundMessage(delivery.route, {
    ...outbound,
    traceId: delivery.traceId ?? outbound.traceId,
  });
  return channel.send(delivery.route.peerId, flattened);
}
