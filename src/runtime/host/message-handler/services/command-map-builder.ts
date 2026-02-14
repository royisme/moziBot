import type { ChannelPlugin } from "../../../adapters/channels/plugin";
import type { InboundMessage } from "../../../adapters/channels/types";
import { handleReasoningCommand, handleThinkCommand } from "../../commands/reasoning";
import type { AgentManager } from "../../..";
import type { CommandHandlerMap } from "./command-handlers";
import { createMessageCommandHandlerMap } from "./command-map";

export function buildCommandHandlerMap(params: {
  channel: ChannelPlugin;
  agentManager: AgentManager;
  interruptSession: (sessionKey: string, reason?: string) => Promise<boolean>;
  handleWhoamiCommand: (params: {
    message: InboundMessage;
    channel: ChannelPlugin;
    peerId: string;
  }) => Promise<void>;
  handleStatusCommand: (params: {
    sessionKey: string;
    agentId: string;
    message: InboundMessage;
    channel: ChannelPlugin;
    peerId: string;
  }) => Promise<void>;
  handleNewSessionCommand: (
    sessionKey: string,
    agentId: string,
    channel: ChannelPlugin,
    peerId: string,
  ) => Promise<void>;
  handleModelsCommand: (
    sessionKey: string,
    agentId: string,
    channel: ChannelPlugin,
    peerId: string,
  ) => Promise<void>;
  handleSwitchCommand: (
    sessionKey: string,
    agentId: string,
    args: string,
    channel: ChannelPlugin,
    peerId: string,
  ) => Promise<void>;
  handleRestartCommand: (channel: ChannelPlugin, peerId: string) => Promise<void>;
  handleCompactCommand: (params: {
    sessionKey: string;
    agentId: string;
    channel: ChannelPlugin;
    peerId: string;
  }) => Promise<void>;
  handleContextCommand: (params: {
    sessionKey: string;
    agentId: string;
    channel: ChannelPlugin;
    peerId: string;
  }) => Promise<void>;
  handleAuthCommand: (params: {
    args: string;
    agentId: string;
    senderId: string;
    channel: ChannelPlugin;
    peerId: string;
  }) => Promise<void>;
  handleRemindersCommand: (params: {
    sessionKey: string;
    message: InboundMessage;
    channel: ChannelPlugin;
    peerId: string;
    args: string;
  }) => Promise<void>;
  handleHeartbeatCommand: (params: {
    agentId: string;
    channel: ChannelPlugin;
    peerId: string;
    args: string;
  }) => Promise<void>;
}): CommandHandlerMap {
  const {
    channel,
    agentManager,
    interruptSession,
    handleWhoamiCommand,
    handleStatusCommand,
    handleNewSessionCommand,
    handleModelsCommand,
    handleSwitchCommand,
    handleRestartCommand,
    handleCompactCommand,
    handleContextCommand,
    handleAuthCommand,
    handleRemindersCommand,
    handleHeartbeatCommand,
  } = params;

  return createMessageCommandHandlerMap({
    channel,
    deps: {
      onWhoami: async ({ message, channel, peerId }) => {
        await handleWhoamiCommand({ message, channel, peerId });
      },
      onStatus: async ({ sessionKey, agentId, message, channel, peerId }) => {
        await handleStatusCommand({ sessionKey, agentId, message, channel, peerId });
      },
      onNew: async ({ sessionKey, agentId, channel, peerId }) => {
        await handleNewSessionCommand(sessionKey, agentId, channel, peerId);
      },
      onModels: async ({ sessionKey, agentId, channel, peerId }) => {
        await handleModelsCommand(sessionKey, agentId, channel, peerId);
      },
      onSwitch: async ({ sessionKey, agentId, args, channel, peerId }) => {
        await handleSwitchCommand(sessionKey, agentId, args, channel, peerId);
      },
      onStop: async ({ sessionKey, channel, peerId }) => {
        const interrupted = await interruptSession(sessionKey, "Stopped by /stop command");
        await channel.send(peerId, {
          text: interrupted
            ? "Stopped active run. You can now /switch and continue."
            : "No active run to stop.",
        });
      },
      onRestart: async ({ channel, peerId }) => {
        await handleRestartCommand(channel, peerId);
      },
      onCompact: async ({ sessionKey, agentId, channel, peerId }) => {
        await handleCompactCommand({ sessionKey, agentId, channel, peerId });
      },
      onContext: async ({ sessionKey, agentId, channel, peerId }) => {
        await handleContextCommand({ sessionKey, agentId, channel, peerId });
      },
      onThink: async ({ sessionKey, agentId, channel, peerId, args }) => {
        await handleThinkCommand({
          agentManager,
          sessionKey,
          agentId,
          channel,
          peerId,
          args,
        });
      },
      onReasoning: async ({ sessionKey, channel, peerId, args }) => {
        await handleReasoningCommand({
          agentManager,
          sessionKey,
          channel,
          peerId,
          args,
        });
      },
      onAuth: async ({ action, agentId, message, channel, peerId, args }) => {
        await handleAuthCommand({
          args: `${action} ${args}`.trim(),
          agentId,
          senderId: message.senderId,
          channel,
          peerId,
        });
      },
      onReminders: async ({ sessionKey, message, channel, peerId, args }) => {
        await handleRemindersCommand({ sessionKey, message, channel, peerId, args });
      },
      onHeartbeat: async ({ agentId, channel, peerId, args }) => {
        await handleHeartbeatCommand({ agentId, channel, peerId, args });
      },
    },
  });
}
