import type { InboundMessage } from "../../../adapters/channels/types";
import type { RuntimeRouter } from "../../router";
import { buildSessionKey } from "../../session-key";

export type LastRoute = {
  channelId: string;
  peerId: string;
  peerType: "dm" | "group" | "channel";
  accountId?: string;
  threadId?: string | number;
};

export type ResolvedSessionContext = {
  agentId: string;
  sessionKey: string;
  dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  peerId: string;
};

export function resolveSessionContext(params: {
  message: InboundMessage;
  router: RuntimeRouter;
  defaultAgentId: string;
}): ResolvedSessionContext {
  const { message, router, defaultAgentId } = params;
  const route = router.resolve(message, defaultAgentId);
  const agentId = route.agentId;
  const sessionKey = buildSessionKey({
    agentId,
    message,
    dmScope: route.dmScope,
  });
  return {
    agentId,
    sessionKey,
    dmScope: route.dmScope,
    peerId: message.peerId,
  };
}

export function rememberLastRoute(params: {
  lastRoutes: Map<string, LastRoute>;
  agentId: string;
  message: InboundMessage;
}): void {
  const { lastRoutes, agentId, message } = params;
  lastRoutes.set(agentId, {
    channelId: message.channel,
    peerId: message.peerId,
    peerType: message.peerType ?? "dm",
    accountId: message.accountId,
    threadId: message.threadId,
  });
}
