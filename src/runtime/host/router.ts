import type { MoziConfig } from "../../config";
import type { InboundMessage } from "../adapters/channels/types";
import type { RouteContext } from "./routing/types";
import { buildSessionKey } from "./session-key";

export type ResolvedRoute = {
  agentId: string;
  dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  mainKey?: string;
  identityLinks?: Record<string, string[]>;
};

export class RuntimeRouter {
  constructor(private config: MoziConfig) {}

  resolve(message: InboundMessage, defaultAgentId: string): ResolvedRoute {
    const channelId = message.channel;
    const sessionCfg = this.config.session as
      | {
          dmScope?: ResolvedRoute["dmScope"];
          mainKey?: string;
          identityLinks?: Record<string, string[]>;
        }
      | undefined;
    const channels = this.config.channels as
      | (Record<string, unknown> & {
          telegram?: {
            groups?: Record<string, { agentId?: string; agent?: string }>;
            dmScope?: ResolvedRoute["dmScope"];
            agentId?: string;
            agent?: string;
          };
          discord?: {
            dmScope?: ResolvedRoute["dmScope"];
            agentId?: string;
            agent?: string;
            guilds?: Record<
              string,
              {
                roleRouting?: Record<string, { agentId?: string; agent?: string }>;
              }
            >;
          };
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

    if (channelId === "discord" && peerType !== "dm") {
      const raw = message.raw as { guildId?: unknown; memberRoleIds?: unknown } | null;
      const guildId = typeof raw?.guildId === "string" ? raw.guildId : undefined;
      const memberRoleIds = Array.isArray(raw?.memberRoleIds)
        ? raw.memberRoleIds.filter((roleId): roleId is string => typeof roleId === "string")
        : [];
      const roleRouting = guildId ? channels?.discord?.guilds?.[guildId]?.roleRouting : undefined;
      if (roleRouting && memberRoleIds.length > 0) {
        for (const [roleId, route] of Object.entries(roleRouting)) {
          if (memberRoleIds.includes(roleId)) {
            agentId = route?.agentId || route?.agent;
            if (agentId) {
              break;
            }
          }
        }
      }
    }

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

    const dmScope = channelCfg?.dmScope || sessionCfg?.dmScope || this.config.channels?.dmScope;
    return {
      agentId: agentId || defaultAgentId,
      dmScope,
      mainKey: sessionCfg?.mainKey,
      identityLinks: sessionCfg?.identityLinks,
    };
  }

  /**
   * Derive the canonical sessionKey from an agentId and RouteContext directly.
   * Pure function — no InboundMessage construction needed, no side effects.
   * Uses the same dmScope/mainKey/identityLinks resolution as resolveSessionContext().
   */
  resolveSessionKeyFromRoute(agentId: string, route: RouteContext): string {
    const sessionCfg = this.config.session as
      | {
          dmScope?: ResolvedRoute["dmScope"];
          mainKey?: string;
          identityLinks?: Record<string, string[]>;
        }
      | undefined;
    const channels = this.config.channels as
      | (Record<string, unknown> & {
          [channelId: string]: { dmScope?: ResolvedRoute["dmScope"] } | undefined;
        })
      | undefined;
    const channelCfg = channels?.[route.channelId] as
      | { dmScope?: ResolvedRoute["dmScope"] }
      | undefined;
    const dmScope = channelCfg?.dmScope || sessionCfg?.dmScope || this.config.channels?.dmScope;

    // Build a minimal message-like object from RouteContext for buildSessionKey
    const messageProxy: InboundMessage = {
      id: "",
      channel: route.channelId,
      peerId: route.peerId,
      peerType: route.peerType,
      accountId: route.accountId,
      threadId: route.threadId,
      senderId: "",
      timestamp: new Date(),
      text: "",
      raw: null,
    };

    return buildSessionKey({
      agentId,
      message: messageProxy,
      dmScope,
      mainKey: sessionCfg?.mainKey,
      identityLinks: sessionCfg?.identityLinks,
    });
  }
}
