import type { RuntimeHookHandlerMap, RuntimeHookName } from "./types";
import { logger } from "../../logger";
import { createRuntimeHookRunner, RuntimeHookRegistry } from "./runner";

const globalRegistry = new RuntimeHookRegistry();
const globalRunner = createRuntimeHookRunner(globalRegistry, {
  catchErrors: true,
  logger: {
    debug: (message) => logger.debug({ message }, "Runtime hook debug"),
    warn: (message) => logger.warn({ message }, "Runtime hook warn"),
    error: (message) => logger.error({ message }, "Runtime hook error"),
  },
});

export function registerRuntimeHook<K extends RuntimeHookName>(
  hookName: K,
  handler: RuntimeHookHandlerMap[K],
  opts?: { id?: string; priority?: number },
): string {
  return globalRegistry.register(hookName, handler, opts);
}

export function unregisterRuntimeHook(id: string): boolean {
  return globalRegistry.unregister(id);
}

export function clearRuntimeHooks(): void {
  globalRegistry.clear();
}

export function getRuntimeHookRunner() {
  return globalRunner;
}

export { RuntimeHookRegistry, createRuntimeHookRunner };
export type { RuntimeHookRunner } from "./runner";
export type * from "./types";
