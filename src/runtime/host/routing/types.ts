export interface RouteContext {
  readonly channelId: string;
  readonly peerId: string;
  readonly peerType: "dm" | "group" | "channel";
  readonly accountId?: string;
  readonly threadId?: string;
  readonly replyToId?: string;
}

export interface DeliveryContext {
  readonly route: RouteContext;
  readonly traceId?: string;
  readonly sessionKey?: string;
  readonly agentId?: string;
  readonly source?: "turn" | "job" | "followup" | "reminder" | "heartbeat" | "system";
}

export interface ResolvedTurnContext {
  readonly agentId: string;
  readonly sessionKey: string;
  readonly dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  readonly route: RouteContext;
}

export type LastRouteContext = RouteContext;
