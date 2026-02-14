import type { ChannelPlugin } from "../../adapters/channels/plugin";
import type { InboundMessage } from "../../adapters/channels/types";
import type { ParsedCommand } from "./parser";

export type CommandHandlers = {
  onHelp: () => Promise<void>;
  onWhoami: () => Promise<void>;
  onStatus: () => Promise<void>;
  onNew: () => Promise<void>;
  onModels: () => Promise<void>;
  onSwitch: (args: string) => Promise<void>;
  onStop: () => Promise<boolean>;
  onRestart: () => Promise<void>;
  onCompact: () => Promise<void>;
  onContext: () => Promise<void>;
  onAuth: (name: "setauth" | "unsetauth" | "listauth" | "checkauth", args: string) => Promise<void>;
  onReminders: (args: string) => Promise<void>;
  onHeartbeat: (args: string) => Promise<void>;
  onThink: (args: string) => Promise<void>;
  onReasoning: (args: string) => Promise<void>;
};

export async function dispatchParsedCommand(params: {
  parsedCommand: ParsedCommand | null;
  sessionKey: string;
  agentId: string;
  message: InboundMessage;
  channel: ChannelPlugin;
  peerId: string;
  handlers: CommandHandlers;
}): Promise<{ handled: boolean; command?: string; interrupted?: boolean }> {
  const { parsedCommand, handlers } = params;
  if (!parsedCommand) {
    return { handled: false };
  }

  if (parsedCommand.name === "help") {
    await handlers.onHelp();
    return { handled: true, command: "help" };
  }
  if (parsedCommand.name === "whoami") {
    await handlers.onWhoami();
    return { handled: true, command: "whoami" };
  }
  if (parsedCommand.name === "status") {
    await handlers.onStatus();
    return { handled: true, command: "status" };
  }
  if (parsedCommand.name === "new") {
    await handlers.onNew();
    return { handled: true, command: "new" };
  }
  if (parsedCommand.name === "models") {
    await handlers.onModels();
    return { handled: true, command: "models" };
  }
  if (parsedCommand.name === "switch") {
    await handlers.onSwitch(parsedCommand.args);
    return { handled: true, command: "switch" };
  }
  if (parsedCommand.name === "stop") {
    const interrupted = await handlers.onStop();
    return { handled: true, command: "stop", interrupted };
  }
  if (parsedCommand.name === "restart") {
    await handlers.onRestart();
    return { handled: true, command: "restart" };
  }
  if (parsedCommand.name === "compact") {
    await handlers.onCompact();
    return { handled: true, command: "compact" };
  }
  if (parsedCommand.name === "context") {
    await handlers.onContext();
    return { handled: true, command: "context" };
  }
  if (
    parsedCommand.name === "setauth" ||
    parsedCommand.name === "unsetauth" ||
    parsedCommand.name === "listauth" ||
    parsedCommand.name === "checkauth"
  ) {
    await handlers.onAuth(parsedCommand.name, parsedCommand.args);
    return { handled: true, command: parsedCommand.name };
  }
  if (parsedCommand.name === "reminders") {
    await handlers.onReminders(parsedCommand.args);
    return { handled: true, command: "reminders" };
  }
  if (parsedCommand.name === "heartbeat") {
    await handlers.onHeartbeat(parsedCommand.args);
    return { handled: true, command: "heartbeat" };
  }
  if (parsedCommand.name === "think") {
    await handlers.onThink(parsedCommand.args);
    return { handled: true, command: "think" };
  }
  if (parsedCommand.name === "reasoning") {
    await handlers.onReasoning(parsedCommand.args);
    return { handled: true, command: "reasoning" };
  }
  return { handled: false };
}
