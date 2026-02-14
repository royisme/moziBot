import type { ChannelPlugin } from "../../../adapters/channels/plugin";
import type { InboundMessage } from "../../../adapters/channels/types";
import { buildMessageCommandHandlerMap, type MessageCommandRegistryDeps } from "./command-registry";
import type { CommandHandlerMap } from "./command-handlers";

export function createMessageCommandHandlerMap(params: {
  channel: ChannelPlugin;
  deps: {
    onWhoami: (params: { message: InboundMessage; channel: ChannelPlugin; peerId: string }) => Promise<void>;
    onStatus: (params: {
      sessionKey: string;
      agentId: string;
      message: InboundMessage;
      channel: ChannelPlugin;
      peerId: string;
    }) => Promise<void>;
    onNew: (params: {
      sessionKey: string;
      agentId: string;
      channel: ChannelPlugin;
      peerId: string;
    }) => Promise<void>;
    onModels: (params: {
      sessionKey: string;
      agentId: string;
      channel: ChannelPlugin;
      peerId: string;
    }) => Promise<void>;
    onSwitch: (params: {
      sessionKey: string;
      agentId: string;
      args: string;
      channel: ChannelPlugin;
      peerId: string;
    }) => Promise<void>;
    onStop: (params: { sessionKey: string; channel: ChannelPlugin; peerId: string }) => Promise<void>;
    onRestart: (params: { channel: ChannelPlugin; peerId: string }) => Promise<void>;
    onCompact: (params: {
      sessionKey: string;
      agentId: string;
      channel: ChannelPlugin;
      peerId: string;
    }) => Promise<void>;
    onContext: (params: {
      sessionKey: string;
      agentId: string;
      channel: ChannelPlugin;
      peerId: string;
    }) => Promise<void>;
    onThink: (params: {
      sessionKey: string;
      agentId: string;
      channel: ChannelPlugin;
      peerId: string;
      args: string;
    }) => Promise<void>;
    onReasoning: (params: {
      sessionKey: string;
      channel: ChannelPlugin;
      peerId: string;
      args: string;
    }) => Promise<void>;
    onAuth: (params: {
      action: "set" | "unset" | "list" | "check";
      agentId: string;
      message: InboundMessage;
      channel: ChannelPlugin;
      peerId: string;
      args: string;
    }) => Promise<void>;
    onReminders: (params: {
      sessionKey: string;
      message: InboundMessage;
      channel: ChannelPlugin;
      peerId: string;
      args: string;
    }) => Promise<void>;
    onHeartbeat: (params: {
      agentId: string;
      channel: ChannelPlugin;
      peerId: string;
      args: string;
    }) => Promise<void>;
  };
}): CommandHandlerMap {
  const { channel, deps } = params;

  const registryDeps: MessageCommandRegistryDeps = {
    channel: {
      send: async (peerId, payload) => {
        await channel.send(peerId, payload);
      },
    },
    onWhoami: async ({ message, peerId }) => {
      await deps.onWhoami({ message, channel, peerId });
    },
    onStatus: async ({ sessionKey, agentId, message, peerId }) => {
      await deps.onStatus({ sessionKey, agentId, message, channel, peerId });
    },
    onNew: async ({ sessionKey, agentId, peerId }) => {
      await deps.onNew({ sessionKey, agentId, channel, peerId });
    },
    onModels: async ({ sessionKey, agentId, peerId }) => {
      await deps.onModels({ sessionKey, agentId, channel, peerId });
    },
    onSwitch: async ({ sessionKey, agentId, peerId, args }) => {
      await deps.onSwitch({ sessionKey, agentId, args, channel, peerId });
    },
    onStop: async ({ sessionKey, peerId }) => {
      await deps.onStop({ sessionKey, channel, peerId });
    },
    onRestart: async ({ peerId }) => {
      await deps.onRestart({ channel, peerId });
    },
    onCompact: async ({ sessionKey, agentId, peerId }) => {
      await deps.onCompact({ sessionKey, agentId, channel, peerId });
    },
    onContext: async ({ sessionKey, agentId, peerId }) => {
      await deps.onContext({ sessionKey, agentId, channel, peerId });
    },
    onThink: async ({ sessionKey, agentId, peerId, args }) => {
      await deps.onThink({ sessionKey, agentId, channel, peerId, args });
    },
    onReasoning: async ({ sessionKey, peerId, args }) => {
      await deps.onReasoning({ sessionKey, channel, peerId, args });
    },
    onSetAuth: async ({ agentId, message, peerId, args }) => {
      await deps.onAuth({ action: "set", agentId, message, channel, peerId, args });
    },
    onUnsetAuth: async ({ agentId, message, peerId, args }) => {
      await deps.onAuth({ action: "unset", agentId, message, channel, peerId, args });
    },
    onListAuth: async ({ agentId, message, peerId, args }) => {
      await deps.onAuth({ action: "list", agentId, message, channel, peerId, args });
    },
    onCheckAuth: async ({ agentId, message, peerId, args }) => {
      await deps.onAuth({ action: "check", agentId, message, channel, peerId, args });
    },
    onReminders: async ({ sessionKey, message, peerId, args }) => {
      await deps.onReminders({ sessionKey, message, channel, peerId, args });
    },
    onHeartbeat: async ({ agentId, peerId, args }) => {
      await deps.onHeartbeat({ agentId, channel, peerId, args });
    },
  };

  return buildMessageCommandHandlerMap(registryDeps);
}
