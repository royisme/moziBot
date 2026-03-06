import type { InboundMessage, OutboundMessage } from "../../adapters/channels/types";
import type { RouteContext } from "./types";

type NormalizeRouteContextInput = {
  channelId: string;
  peerId: string;
  peerType: "dm" | "group" | "channel";
  accountId?: string | number;
  threadId?: string | number;
  replyToId?: string | number;
};

function normalizeOptionalString(value: string | number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return String(value);
}

export function normalizeRouteContext(input: NormalizeRouteContextInput): RouteContext {
  return {
    channelId: input.channelId,
    peerId: input.peerId,
    peerType: input.peerType,
    accountId: normalizeOptionalString(input.accountId),
    threadId: normalizeOptionalString(input.threadId),
    replyToId: normalizeOptionalString(input.replyToId),
  };
}

export function routeContextFromInbound(message: InboundMessage): RouteContext {
  return normalizeRouteContext({
    channelId: message.channel,
    peerId: message.peerId,
    peerType: message.peerType ?? "dm",
    accountId: message.accountId,
    threadId: message.threadId,
    replyToId: message.replyToId,
  });
}

export function routeContextToOutboundMessage(
  route: RouteContext,
  message: OutboundMessage,
): OutboundMessage {
  return {
    ...message,
    threadId: message.threadId ?? route.threadId,
    replyToId: message.replyToId ?? route.replyToId,
  };
}

export function sameRouteContext(
  a: RouteContext | null | undefined,
  b: RouteContext | null | undefined,
): boolean {
  if (!a || !b) {
    return a === b;
  }
  return (
    a.channelId === b.channelId &&
    a.peerId === b.peerId &&
    a.peerType === b.peerType &&
    a.accountId === b.accountId &&
    a.threadId === b.threadId &&
    a.replyToId === b.replyToId
  );
}
