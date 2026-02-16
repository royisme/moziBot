import type { DeliveryPlan } from "../../../../multimodal/capabilities";
import type { OutboundMessage } from "../../../adapters/channels/types";
import { planOutboundByNegotiation } from "../../../../multimodal/outbound";
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
  peerId: string;
  channelId: string;
  replyText?: string;
  inboundPlan?: DeliveryPlan | null;
  traceId?: string;
  showThinking?: boolean;
}): Promise<string> {
  const { channel, peerId, channelId, replyText, inboundPlan, traceId, showThinking } = params;
  const outbound = buildReplyOutbound({
    channelId,
    replyText,
    inboundPlan,
    showThinking,
  });
  if (traceId) {
    outbound.traceId = traceId;
  }
  return channel.send(peerId, outbound);
}
