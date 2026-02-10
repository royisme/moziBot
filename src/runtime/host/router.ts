import type { MoziConfig } from "../../config";
import type { InboundMessage } from "../adapters/channels/types";

export type ResolvedRoute = {
  agentId: string;
  dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
};

export class RuntimeRouter {
  constructor(private config: MoziConfig) {}

  resolve(message: InboundMessage, defaultAgentId: string): ResolvedRoute {
    const channelId = message.channel;
    const channels = this.config.channels as
      | (Record<string, unknown> & {
          telegram?: {
            groups?: Record<string, { agentId?: string; agent?: string }>;
            dmScope?: ResolvedRoute["dmScope"];
            agentId?: string;
            agent?: string;
          };
          discord?: { dmScope?: ResolvedRoute["dmScope"]; agentId?: string; agent?: string };
        })
      | undefined;
    const channelCfg = channels?.[channelId] as
      | { agentId?: string; agent?: string; dmScope?: ResolvedRoute["dmScope"] }
      | undefined;
    const routing = (
      this.config.channels as
        | {
            routing?: {
              groupAgentId?: string;
              groupAgent?: string;
              dmAgentId?: string;
              dmAgent?: string;
            };
          }
        | undefined
    )?.routing;
    const peerType = message.peerType ?? "dm";

    let agentId: string | undefined;

    if (channelId === "telegram" && peerType !== "dm") {
      const groupCfg = channels?.telegram?.groups?.[message.peerId];
      agentId = groupCfg?.agentId || groupCfg?.agent;
    }

    if (!agentId) {
      agentId = channelCfg?.agentId || channelCfg?.agent;
    }
    if (!agentId && routing) {
      if (peerType === "group" || peerType === "channel") {
        agentId = routing.groupAgentId || routing.groupAgent;
      } else {
        agentId = routing.dmAgentId || routing.dmAgent;
      }
    }

    const dmScope = channelCfg?.dmScope || this.config.channels?.dmScope;
    return { agentId: agentId || defaultAgentId, dmScope };
  }
}
