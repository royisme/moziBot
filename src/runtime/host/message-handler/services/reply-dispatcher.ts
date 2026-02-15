import type { DeliveryPlan } from "../../../../multimodal/capabilities";
import type { OutboundMessage } from "../../../adapters/channels/types";
import { planOutboundByNegotiation } from "../../../../multimodal/outbound";

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

export interface StreamingBufferShape {
  readonly finalize: (replyText?: string) => Promise<string | null>;
}

/**
 * Finalizes a streaming reply by committing the buffer to the channel.
 */
export async function finalizeStreamingReply(params: {
  buffer: StreamingBufferShape;
  replyText?: string;
}): Promise<string | null> {
  const { buffer, replyText } = params;
  return buffer.finalize(replyText);
}

/**
 * Builds a planned outbound message using multimodal negotiation logic.
 * Preserves monolith fallback and channel ID passing logic.
 * Strict typing only, no 'any' or 'as any'.
 */
export function buildNegotiatedOutbound(params: {
  channelId: string;
  replyText?: string;
  inboundPlan?: DeliveryPlan | null;
}): OutboundMessage {
  const { channelId, replyText, inboundPlan } = params;

  // Parity: use "(no response)" fallback for empty rendered text
  const text = replyText || "(no response)";

  // Parity: delegate to multimodal negotiation logic
  return planOutboundByNegotiation({
    channelId,
    text,
    inboundPlan,
  });
}

/**
 * Sends a negotiated outbound message to the specified peer.
 */
export async function sendNegotiatedReply(params: {
  channel: ChannelDispatcherShape;
  peerId: string;
  outbound: OutboundMessage;
}): Promise<string> {
  const { channel, peerId, outbound } = params;
  return channel.send(peerId, outbound);
}
