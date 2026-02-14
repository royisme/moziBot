import type { CommandFlow } from '../contract';
import { 
  type ParsedCommand, 
  type CommandHandlerMap, 
  type CommandDispatchContext, 
  dispatchParsedCommand 
} from '../services/command-handlers';

/**
 * Runtime-guarded helper to ensure a function exists on an unknown object.
 */
function requireFn<T extends (...args: unknown[]) => unknown>(deps: unknown, key: string): T {
  if (!deps || typeof deps !== "object") {
    throw new Error(`Missing dependency container for function: ${key}`);
  }
  const obj = deps as Record<string, unknown>;
  const fn = obj[key];
  if (typeof fn !== "function") {
    throw new Error(`Missing required dependency function: ${key}`);
  }
  return fn as T;
}

/**
 * Type guard for ParsedCommand structure.
 */
function isParsedCommand(obj: unknown): obj is ParsedCommand {
  if (!obj || typeof obj !== "object") {
    return false;
  }
  const maybe = obj as Record<string, unknown>;
  return typeof maybe.name === "string" && typeof maybe.args === "string";
}

/**
 * Command Flow Implementation
 * 
 * Orchestrates the dispatching of parsed commands using artifacts stored
 * in ctx.state and services/command-handlers helpers.
 * Preserves monolith parity with strict narrow guards.
 */
export const runCommandFlow: CommandFlow = async (ctx, deps) => {
  const { state, payload } = ctx;

  // 1. Narrow guard for parsed command artifact from Inbound Flow
  const rawCommand = state.parsedCommand;
  const inlineOverrides = state.inlineOverrides;
  if (rawCommand === null || rawCommand === undefined) {
    return "continue";
  }

  if (
    inlineOverrides &&
    typeof inlineOverrides === "object" &&
    (rawCommand as { name?: string }).name &&
    (((rawCommand as { name?: string }).name === "think") ||
      ((rawCommand as { name?: string }).name === "reasoning"))
  ) {
    return "continue";
  }

  if (!isParsedCommand(rawCommand)) {
    // Artifact exists but is malformed
    return "abort";
  }

  try {
    // 2. Narrow guard for required session context artifacts from state
    const sessionKey = typeof state.sessionKey === "string" ? state.sessionKey : undefined;
    const agentId = typeof state.agentId === "string" ? state.agentId : undefined;
    const peerId = typeof state.peerId === "string" ? state.peerId : undefined;

    if (!sessionKey || !agentId || !peerId) {
      // Missing required context for command dispatch
      return "abort";
    }

    // 3. Obtain injected command handler map and channel from deps
    const getHandlerMap = requireFn<() => CommandHandlerMap>(deps, "getCommandHandlerMap");
    const getChannel = requireFn<(p: unknown) => unknown>(deps, "getChannel");
    
    const handlerMap = getHandlerMap();
    const channel = getChannel(payload);

    // 4. Build CommandDispatchContext
    const dispatchContext: CommandDispatchContext = {
      sessionKey,
      agentId,
      peerId,
      startedAt: ctx.startTime,
      message: payload,
      channel,
    };

    // 5. Dispatch
    const handled = await dispatchParsedCommand(rawCommand, handlerMap, dispatchContext);

    return handled ? "handled" : "continue";
  } catch {
    // TODO: Connect to centralized error flow
    return "abort";
  }
};
