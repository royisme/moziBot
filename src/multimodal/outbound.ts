import type { OutboundMessage } from "../runtime/adapters/channels/types";
import type { DeliveryPlan } from "./capabilities";

export function planOutboundByNegotiation(params: {
  channelId: string;
  text: string;
  inboundPlan?: DeliveryPlan | null;
}): OutboundMessage {
  const text = params.text || "(no response)";
  const allowed = new Set(params.inboundPlan?.outputModalities ?? ["text"]);
  if (!allowed.has("text")) {
    return { text: "This channel does not support text output." };
  }

  if (params.channelId === "discord" && !allowed.has("audio")) {
    return { text };
  }

  if (params.channelId === "telegram" && !allowed.has("video")) {
    return { text };
  }

  return { text };
}
