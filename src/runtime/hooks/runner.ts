import type {
  AfterToolCallContext,
  AfterToolCallEvent,
  BeforeAgentStartContext,
  BeforeAgentStartEvent,
  BeforeAgentStartResult,
  BeforeResetContext,
  BeforeResetEvent,
  BeforeToolCallContext,
  BeforeToolCallEvent,
  BeforeToolCallResult,
  RuntimeHookHandlerMap,
  RuntimeHookName,
  RuntimeHookRegistration,
  TurnCompletedContext,
  TurnCompletedEvent,
} from "./types";

export type RuntimeHookRunnerLogger = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type RuntimeHookRunnerOptions = {
  catchErrors?: boolean;
  logger?: RuntimeHookRunnerLogger;
};

let hookSequence = 0;

export class RuntimeHookRegistry {
  private readonly hooks: RuntimeHookRegistration[] = [];

  register<K extends RuntimeHookName>(
    hookName: K,
    handler: RuntimeHookHandlerMap[K],
    opts?: { id?: string; priority?: number },
  ): string {
    const id = opts?.id?.trim() || `${hookName}:${++hookSequence}`;
    this.hooks.push({ id, hookName, handler, priority: opts?.priority });
    return id;
  }

  clear(): void {
    this.hooks.length = 0;
  }

  list(): RuntimeHookRegistration[] {
    return [...this.hooks];
  }
}

function getHooksForName<K extends RuntimeHookName>(
  registry: RuntimeHookRegistry,
  hookName: K,
): RuntimeHookRegistration<K>[] {
  return (registry.list() as RuntimeHookRegistration<K>[])
    .filter((entry) => entry.hookName === hookName)
    .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

export function createRuntimeHookRunner(
  registry: RuntimeHookRegistry,
  options: RuntimeHookRunnerOptions = {},
) {
  const catchErrors = options.catchErrors ?? true;
  const logger = options.logger;

  async function runObserverHook<K extends RuntimeHookName>(
    hookName: K,
    event: Parameters<RuntimeHookHandlerMap[K]>[0],
    ctx: Parameters<RuntimeHookHandlerMap[K]>[1],
  ): Promise<void> {
    const hooks = getHooksForName(registry, hookName);
    if (hooks.length === 0) {
      return;
    }

    const tasks = hooks.map(async (entry) => {
      try {
        await (
          entry.handler as (
            evt: Parameters<RuntimeHookHandlerMap[K]>[0],
            context: Parameters<RuntimeHookHandlerMap[K]>[1],
          ) => Promise<void> | void
        )(event, ctx);
      } catch (error) {
        const message = `[runtime-hooks] ${hookName} failed (${entry.id}): ${String(error)}`;
        if (catchErrors) {
          logger?.error?.(message);
        } else {
          throw new Error(message, { cause: error });
        }
      }
    });

    await Promise.all(tasks);
  }

  async function runBeforeAgentStart(
    event: BeforeAgentStartEvent,
    ctx: BeforeAgentStartContext,
  ): Promise<BeforeAgentStartResult | undefined> {
    const hooks = getHooksForName(registry, "before_agent_start");
    if (hooks.length === 0) {
      return undefined;
    }

    let promptText = event.promptText;
    let modified = false;

    for (const entry of hooks) {
      try {
        const result = await entry.handler({ ...event, promptText }, ctx);
        if (result?.block) {
          return { block: true, blockReason: result.blockReason };
        }
        if (typeof result?.promptText === "string") {
          promptText = result.promptText;
          modified = true;
        }
      } catch (error) {
        const message = `[runtime-hooks] before_agent_start failed (${entry.id}): ${String(error)}`;
        if (catchErrors) {
          logger?.error?.(message);
          continue;
        }
        throw new Error(message, { cause: error });
      }
    }

    return modified ? { promptText } : undefined;
  }

  async function runBeforeToolCall(
    event: BeforeToolCallEvent,
    ctx: BeforeToolCallContext,
  ): Promise<BeforeToolCallResult | undefined> {
    const hooks = getHooksForName(registry, "before_tool_call");
    if (hooks.length === 0) {
      return undefined;
    }

    let args = event.args;
    let modified = false;

    for (const entry of hooks) {
      try {
        const result = await entry.handler({ ...event, args }, ctx);
        if (result?.block) {
          return { block: true, blockReason: result.blockReason };
        }
        if (result?.args && typeof result.args === "object") {
          args = result.args;
          modified = true;
        }
      } catch (error) {
        const message = `[runtime-hooks] before_tool_call failed (${entry.id}): ${String(error)}`;
        if (catchErrors) {
          logger?.error?.(message);
          continue;
        }
        throw new Error(message, { cause: error });
      }
    }

    return modified ? { args } : undefined;
  }

  async function runAfterToolCall(event: AfterToolCallEvent, ctx: AfterToolCallContext) {
    return runObserverHook("after_tool_call", event, ctx);
  }

  async function runBeforeReset(event: BeforeResetEvent, ctx: BeforeResetContext) {
    return runObserverHook("before_reset", event, ctx);
  }

  async function runTurnCompleted(event: TurnCompletedEvent, ctx: TurnCompletedContext) {
    return runObserverHook("turn_completed", event, ctx);
  }

  function hasHooks(hookName: RuntimeHookName): boolean {
    return getHooksForName(registry, hookName).length > 0;
  }

  function getHookCount(hookName: RuntimeHookName): number {
    return getHooksForName(registry, hookName).length;
  }

  return {
    runBeforeAgentStart,
    runBeforeToolCall,
    runAfterToolCall,
    runBeforeReset,
    runTurnCompleted,
    hasHooks,
    getHookCount,
    registry,
  };
}

export type RuntimeHookRunner = ReturnType<typeof createRuntimeHookRunner>;
