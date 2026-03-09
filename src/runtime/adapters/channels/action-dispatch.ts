import type { DeliveryPlan } from "../../../multimodal/capabilities";
import type {
  ChannelAction,
  ChannelActionEnvelope,
  ChannelActionName,
  CurrentChannelContext,
  OutboundMessage,
} from "./types";

function fallbackNoTextMessage(): string {
  return "This channel does not support text output.";
}

function ensureAllowed(action: ChannelAction, allowedActions: Set<ChannelActionName>): void {
  if (!allowedActions.has(action.type)) {
    throw new Error(`Channel action not allowed in current context: ${action.type}`);
  }
}

export function normalizeChannelActionEnvelope(params: {
  envelope: ChannelActionEnvelope;
  currentChannel: CurrentChannelContext;
}): ChannelActionEnvelope {
  const allowedActions = new Set(params.currentChannel.allowedActions);
  const actions = params.envelope.actions.map((action) => {
    ensureAllowed(action, allowedActions);
    return {
      ...action,
      target: {
        peerId: action.target?.peerId ?? params.currentChannel.defaultTarget.peerId,
        threadId: action.target?.threadId ?? params.currentChannel.defaultTarget.threadId,
        replyToId: action.target?.replyToId ?? params.currentChannel.defaultTarget.replyToId,
        messageId: action.target?.messageId,
      },
    } satisfies ChannelAction;
  });
  return {
    actions,
    fallbackText: params.envelope.fallbackText,
  };
}

export function lowerChannelActionToOutbound(action: ChannelAction): OutboundMessage {
  switch (action.type) {
    case "send_text":
    case "reply":
      return {
        text: action.text,
        buttons: action.buttons,
        silent: action.silent,
        threadId: action.target?.threadId,
        replyToId: action.target?.replyToId,
      };
    case "send_media":
      return {
        text: action.text,
        media: action.media,
        buttons: action.buttons,
        silent: action.silent,
        threadId: action.target?.threadId,
        replyToId: action.target?.replyToId,
      };
    case "poll":
      return {
        poll: {
          question: action.question,
          options: action.options,
          allowMultiselect: action.allowMultiselect,
          durationHours: action.durationHours,
        },
        threadId: action.target?.threadId,
        replyToId: action.target?.replyToId,
      };
    default:
      throw new Error(`Channel action cannot be lowered to outbound message: ${action.type}`);
  }
}

export function lowerChannelActionEnvelopeToOutbound(params: {
  envelope: ChannelActionEnvelope;
  currentChannel: CurrentChannelContext;
  traceId?: string;
}): { peerId: string; messages: OutboundMessage[] } {
  const normalized = normalizeChannelActionEnvelope(params);
  const peerIds = Array.from(
    new Set(
      normalized.actions
        .map((action) => action.target?.peerId)
        .filter((peerId): peerId is string => Boolean(peerId)),
    ),
  );
  if (peerIds.length > 1) {
    throw new Error("Channel action envelope cannot target multiple peerIds in a single dispatch");
  }
  const messages = normalized.actions.map((action) => ({
    ...lowerChannelActionToOutbound(action),
    traceId: params.traceId,
  }));
  if (messages.length === 0 && normalized.fallbackText) {
    messages.push({
      text: normalized.fallbackText,
      threadId: params.currentChannel.defaultTarget.threadId,
      replyToId: params.currentChannel.defaultTarget.replyToId,
      traceId: params.traceId,
    });
  }
  return {
    peerId: normalized.actions[0]?.target?.peerId ?? params.currentChannel.defaultTarget.peerId,
    messages,
  };
}

export function buildChannelActionEnvelope(params: {
  channelId: string;
  text: string;
  inboundPlan?: DeliveryPlan | null;
  currentChannel: CurrentChannelContext;
  media?: OutboundMessage["media"];
  buttons?: OutboundMessage["buttons"];
  silent?: boolean;
}): ChannelActionEnvelope {
  const text = params.text || "(no response)";
  const allowedModalities = new Set(params.inboundPlan?.outputModalities ?? ["text"]);
  const actions: ChannelAction[] = [];

  if (params.media?.length) {
    if (
      !params.currentChannel.capabilities.media ||
      !params.currentChannel.allowedActions.includes("send_media")
    ) {
      if (!params.currentChannel.allowedActions.includes("send_text")) {
        return {
          actions: [],
          fallbackText: text,
        };
      }
      return {
        actions: [
          {
            type: "send_text",
            text,
            buttons: params.buttons,
            silent: params.silent,
          },
        ],
        fallbackText: text,
      };
    }

    actions.push({
      type: "send_media",
      text,
      media: params.media,
      buttons: params.buttons,
      silent: params.silent,
    });
    return { actions };
  }

  if (!allowedModalities.has("text")) {
    return {
      actions: [],
      fallbackText: fallbackNoTextMessage(),
    };
  }

  if (!params.currentChannel.allowedActions.includes("send_text")) {
    return {
      actions: [],
      fallbackText: text,
    };
  }

  if (params.channelId === "discord" && !allowedModalities.has("audio")) {
    actions.push({ type: "send_text", text, buttons: params.buttons, silent: params.silent });
    return { actions };
  }

  if (params.channelId === "telegram" && !allowedModalities.has("video")) {
    actions.push({ type: "send_text", text, buttons: params.buttons, silent: params.silent });
    return { actions };
  }

  actions.push({ type: "send_text", text, buttons: params.buttons, silent: params.silent });
  return { actions };
}
