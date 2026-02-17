/**
 * Command Dispatch and Registry Service
 *
 * Manages the routing of parsed commands to their respective implementations.
 * Decouples the branching logic from the main orchestrator.
 */

export type ParsedCommandName = string;

export interface ParsedCommand {
  readonly name: ParsedCommandName;
  readonly args: string;
}

export interface CommandDispatchContext {
  readonly sessionKey: string;
  readonly agentId: string;
  readonly peerId: string;
  readonly startedAt: number;
  readonly message: unknown; // InboundMessage shape
  readonly channel: unknown; // ChannelPlugin shape
}

export type CommandHandler = (ctx: CommandDispatchContext, args: string) => Promise<void> | void;

export type CommandHandlerMap = Partial<Record<ParsedCommandName, CommandHandler>>;

/**
 * Utility to create a command handler map from a set of injected callbacks.
 */
export function createCommandHandlerMap(handlers: CommandHandlerMap): CommandHandlerMap {
  return handlers;
}

/**
 * Dispatches a parsed command to the appropriate handler in the map.
 * Returns true if a handler was found and executed.
 */
export async function dispatchParsedCommand(
  parsedCommand: ParsedCommand,
  handlerMap: CommandHandlerMap,
  context: CommandDispatchContext,
): Promise<boolean> {
  const handler = handlerMap[parsedCommand.name];

  if (handler) {
    await handler(context, parsedCommand.args);
    return true;
  }

  return false;
}
