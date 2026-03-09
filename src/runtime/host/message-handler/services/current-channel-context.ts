import type { ChannelPlugin } from "../../../adapters/channels/plugin";
import type {
  ChannelActionName,
  ChannelActionSpec,
  CurrentChannelContext,
  InboundMessage,
} from "../../../adapters/channels/types";
import type { DeliveryContext, RouteContext } from "../../routing/types";

function uniqueActions(actions: ChannelActionName[]): ChannelActionName[] {
  return Array.from(new Set(actions));
}

function resolveAllowedActions(params: {
  plugin: ChannelPlugin;
  message?: InboundMessage;
  route: RouteContext;
}): ChannelActionName[] {
  const specs =
    params.plugin.listActions?.({
      peerType: params.message?.peerType ?? params.route.peerType,
      threadId: params.message?.threadId ? String(params.message.threadId) : params.route.threadId,
      accountId: params.message?.accountId
        ? String(params.message.accountId)
        : params.route.accountId,
    }) ?? [];

  const enabledFromSpecs = specs
    .filter((spec: ChannelActionSpec) => spec.enabled)
    .map((spec) => spec.name);
  const fallback = params.plugin.getCapabilities().supportedActions;
  return uniqueActions(specs.length > 0 ? enabledFromSpecs : fallback);
}

export function buildCurrentChannelContext(params: {
  plugin: ChannelPlugin;
  route: RouteContext;
  sessionKey?: string;
  message?: InboundMessage;
}): CurrentChannelContext {
  const { plugin, route, sessionKey, message } = params;
  const capabilities = plugin.getCapabilities();
  return {
    channelId: route.channelId,
    peerId: route.peerId,
    peerType: message?.peerType ?? route.peerType,
    accountId: message?.accountId ? String(message.accountId) : route.accountId,
    threadId: message?.threadId ? String(message.threadId) : route.threadId,
    replyToId: message?.replyToId ? String(message.replyToId) : route.replyToId,
    sessionKey,
    capabilities,
    allowedActions: resolveAllowedActions({ plugin, message, route }),
    defaultTarget: {
      peerId: route.peerId,
      threadId: message?.threadId ? String(message.threadId) : route.threadId,
      replyToId: message?.replyToId ? String(message.replyToId) : route.replyToId,
    },
  };
}

export function buildCurrentChannelContextFromInbound(params: {
  plugin: ChannelPlugin;
  message: InboundMessage;
  sessionKey?: string;
}): CurrentChannelContext {
  const { plugin, message, sessionKey } = params;
  return buildCurrentChannelContext({
    plugin,
    sessionKey,
    message,
    route: {
      channelId: message.channel,
      peerId: message.peerId,
      peerType: message.peerType ?? "dm",
      accountId: message.accountId ? String(message.accountId) : undefined,
      threadId: message.threadId ? String(message.threadId) : undefined,
      replyToId: message.replyToId ? String(message.replyToId) : undefined,
    },
  });
}

export function buildCurrentChannelContextFromDelivery(params: {
  plugin: ChannelPlugin;
  delivery: DeliveryContext;
}): CurrentChannelContext {
  const { plugin, delivery } = params;
  return buildCurrentChannelContext({
    plugin,
    route: delivery.route,
    sessionKey: delivery.sessionKey,
  });
}
