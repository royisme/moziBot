import type { InboundMessage } from "../../../adapters/channels/types";
import type { RuntimeRouter } from "../../router";
import { routeContextFromInbound } from "../../routing/route-context";
import type { LastRouteContext, ResolvedTurnContext } from "../../routing/types";
import { buildSessionKey } from "../../session-key";

export type LastRoute = LastRouteContext;

export type ResolvedSessionContext = ResolvedTurnContext & {
  peerId: string;
};

export function resolveSessionContext(params: {
  message: InboundMessage;
  router: RuntimeRouter;
  defaultAgentId: string;
}): ResolvedSessionContext {
  const { message, router, defaultAgentId } = params;
  const resolvedRoute = router.resolve(message, defaultAgentId);
  const agentId = resolvedRoute.agentId;
  const sessionKey = buildSessionKey({
    agentId,
    message,
    dmScope: resolvedRoute.dmScope,
    mainKey: resolvedRoute.mainKey,
    identityLinks: resolvedRoute.identityLinks,
  });
  const route = routeContextFromInbound(message);
  return {
    agentId,
    sessionKey,
    dmScope: resolvedRoute.dmScope,
    route,
    peerId: route.peerId,
  };
}

export function rememberLastRoute(params: {
  lastRoutes: Map<string, LastRoute>;
  agentId: string;
  route: LastRoute;
}): void {
  const { lastRoutes, agentId, route } = params;
  lastRoutes.set(agentId, route);
}
