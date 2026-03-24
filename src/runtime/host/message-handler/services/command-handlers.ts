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

export interface CommandRegistration {
  handler: CommandHandler;
  bypassQueue?: boolean;
}

/** Input type: accepts raw handlers or full registrations for convenience. */
export type CommandHandlerInput = Partial<
  Record<ParsedCommandName, CommandRegistration | CommandHandler>
>;

/** Normalized output type: all values are CommandRegistration. */
export type CommandHandlerMap = Partial<Record<ParsedCommandName, CommandRegistration>>;

function normalizeRegistration(entry: CommandRegistration | CommandHandler): CommandRegistration {
  if (typeof entry === "function") {
    return { handler: entry };
  }
  return entry;
}

/**
 * Utility to create a command handler map from a set of injected callbacks.
 * Accepts both raw handler functions and full CommandRegistration objects.
 */
export function createCommandHandlerMap(handlers: CommandHandlerInput): CommandHandlerMap {
  return Object.fromEntries(
    Object.entries(handlers).map(([name, entry]) => [name, normalizeRegistration(entry!)]),
  );
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
  const registration = handlerMap[parsedCommand.name];

  if (registration) {
    const normalizedRegistration = normalizeRegistration(registration);
    await normalizedRegistration.handler(context, parsedCommand.args);
    return true;
  }

  return false;
}
