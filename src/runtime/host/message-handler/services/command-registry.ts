import type { InboundMessage } from "../../../adapters/channels/types";
import {
  createCommandHandlerMap,
  type CommandHandlerMap,
  type CommandDispatchContext,
} from "./command-handlers";

export interface MessageCommandRegistryDeps {
  channel: {
    send(peerId: string, payload: { text: string }): Promise<unknown>;
  };
  onWhoami(params: { message: InboundMessage; peerId: string }): Promise<void>;
  onStatus(params: {
    sessionKey: string;
    agentId: string;
    message: InboundMessage;
    peerId: string;
  }): Promise<void>;
  onNew(params: { sessionKey: string; agentId: string; peerId: string }): Promise<void>;
  onModels(params: { sessionKey: string; agentId: string; peerId: string }): Promise<void>;
  onSwitch(params: {
    sessionKey: string;
    agentId: string;
    peerId: string;
    args: string;
  }): Promise<void>;
  onStop(params: { sessionKey: string; peerId: string }): Promise<void>;
  onRestart(params: { peerId: string }): Promise<void>;
  onCompact(params: { sessionKey: string; agentId: string; peerId: string }): Promise<void>;
  onContext(params: { sessionKey: string; agentId: string; peerId: string }): Promise<void>;
  onThink(params: {
    sessionKey: string;
    agentId: string;
    peerId: string;
    args: string;
  }): Promise<void>;
  onReasoning(params: { sessionKey: string; peerId: string; args: string }): Promise<void>;
  onSetAuth(params: {
    agentId: string;
    message: InboundMessage;
    peerId: string;
    args: string;
  }): Promise<void>;
  onUnsetAuth(params: {
    agentId: string;
    message: InboundMessage;
    peerId: string;
    args: string;
  }): Promise<void>;
  onListAuth(params: {
    agentId: string;
    message: InboundMessage;
    peerId: string;
    args: string;
  }): Promise<void>;
  onCheckAuth(params: {
    agentId: string;
    message: InboundMessage;
    peerId: string;
    args: string;
  }): Promise<void>;
  onReminders(params: {
    sessionKey: string;
    message: InboundMessage;
    peerId: string;
    args: string;
  }): Promise<void>;
  onHeartbeat(params: { agentId: string; peerId: string; args: string }): Promise<void>;
}

const HELP_TEXT =
  "Available commands:\n/status View status\n/whoami View identity information\n/new Start new session\n/models List available models\n/switch provider/model Switch model\n/stop Interrupt active run\n/compact Compact session context\n/context View context details\n/restart Restart runtime\n/heartbeat [status|on|off] Heartbeat control\n/reminders Reminder management\n/setAuth set KEY=VALUE [--scope=...]\n/unsetAuth KEY [--scope=...]\n/listAuth [--scope=...]\n/checkAuth KEY [--scope=...]";

export function buildMessageCommandHandlerMap(deps: MessageCommandRegistryDeps): CommandHandlerMap {
  const withInbound = (ctx: CommandDispatchContext): InboundMessage => ctx.message as InboundMessage;

  return createCommandHandlerMap({
    start: async ({ peerId }) => {
      await deps.channel.send(peerId, { text: HELP_TEXT });
    },
    help: async ({ peerId }) => {
      await deps.channel.send(peerId, { text: HELP_TEXT });
    },
    whoami: async (ctx) => {
      await deps.onWhoami({ message: withInbound(ctx), peerId: ctx.peerId });
    },
    status: async (ctx) => {
      await deps.onStatus({
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        message: withInbound(ctx),
        peerId: ctx.peerId,
      });
    },
    new: async (ctx) => {
      await deps.onNew({ sessionKey: ctx.sessionKey, agentId: ctx.agentId, peerId: ctx.peerId });
    },
    models: async (ctx) => {
      await deps.onModels({ sessionKey: ctx.sessionKey, agentId: ctx.agentId, peerId: ctx.peerId });
    },
    switch: async (ctx, args) => {
      await deps.onSwitch({ sessionKey: ctx.sessionKey, agentId: ctx.agentId, peerId: ctx.peerId, args });
    },
    stop: async (ctx) => {
      await deps.onStop({ sessionKey: ctx.sessionKey, peerId: ctx.peerId });
    },
    restart: async (ctx) => {
      await deps.onRestart({ peerId: ctx.peerId });
    },
    compact: async (ctx) => {
      await deps.onCompact({ sessionKey: ctx.sessionKey, agentId: ctx.agentId, peerId: ctx.peerId });
    },
    context: async (ctx) => {
      await deps.onContext({ sessionKey: ctx.sessionKey, agentId: ctx.agentId, peerId: ctx.peerId });
    },
    think: async (ctx, args) => {
      await deps.onThink({
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        peerId: ctx.peerId,
        args,
      });
    },
    reasoning: async (ctx, args) => {
      await deps.onReasoning({ sessionKey: ctx.sessionKey, peerId: ctx.peerId, args });
    },
    setauth: async (ctx, args) => {
      await deps.onSetAuth({
        agentId: ctx.agentId,
        message: withInbound(ctx),
        peerId: ctx.peerId,
        args,
      });
    },
    unsetauth: async (ctx, args) => {
      await deps.onUnsetAuth({
        agentId: ctx.agentId,
        message: withInbound(ctx),
        peerId: ctx.peerId,
        args,
      });
    },
    listauth: async (ctx, args) => {
      await deps.onListAuth({
        agentId: ctx.agentId,
        message: withInbound(ctx),
        peerId: ctx.peerId,
        args,
      });
    },
    checkauth: async (ctx, args) => {
      await deps.onCheckAuth({
        agentId: ctx.agentId,
        message: withInbound(ctx),
        peerId: ctx.peerId,
        args,
      });
    },
    reminders: async (ctx, args) => {
      await deps.onReminders({
        sessionKey: ctx.sessionKey,
        message: withInbound(ctx),
        peerId: ctx.peerId,
        args,
      });
    },
    heartbeat: async (ctx, args) => {
      await deps.onHeartbeat({ agentId: ctx.agentId, peerId: ctx.peerId, args });
    },
  });
}
