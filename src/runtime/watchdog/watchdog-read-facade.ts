import type { RouteContext } from "../host/routing/types.js";

/**
 * Read-only view of runtime state for the WatchdogService.
 * Replaces the direct MessageHandler dependency that HeartbeatRunner had.
 */
export interface WatchdogReadFacade {
  /** Last known route for an agent (undefined if agent has never handled a message). */
  getLastRoute(agentId: string): RouteContext | undefined;
  /** Derive session key from agent ID and route — pure, no side effects. */
  resolveSessionKey(agentId: string, route: RouteContext): string;
  /** Whether the session currently has an active (non-terminal) run. */
  isSessionActive(sessionKey: string): boolean;
  /** Agent's home directory, if available. */
  getHomeDir(agentId: string): string | undefined;
}
