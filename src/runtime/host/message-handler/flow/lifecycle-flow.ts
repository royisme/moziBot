import type { LifecycleFlow } from "../contract";
import {
  resolveTemporalLifecyclePolicy,
  shouldRotateSessionForTemporalPolicy,
} from "../lifecycle/temporal";

/**
 * Lifecycle Flow Implementation
 *
 * Orchestrates temporal and semantic session lifecycle checks and transitions.
 * Preserves monolith parity by skipping for commands and following exact update order.
 */
export const runLifecycleFlow: LifecycleFlow = async (ctx, deps) => {
  const { state } = ctx;
  const resetSession = (sessionKey: string, agentId: string) =>
    deps.resetSession(sessionKey, agentId);
  const getSessionTimestamps = (sessionKey: string) => deps.getSessionTimestamps(sessionKey);
  const getConfigAgents = () => deps.getConfigAgents();
  const { logger } = deps;

  // 1. Skip lifecycle for commands (Monolith parity)
  if (state.parsedCommand) {
    return "continue";
  }

  try {
    // Narrow guard for required artifacts from state
    const sessionKey = typeof state.sessionKey === "string" ? state.sessionKey : undefined;
    const agentId = typeof state.agentId === "string" ? state.agentId : undefined;
    const text = typeof state.text === "string" ? state.text : undefined;

    if (!sessionKey || !agentId || text === undefined) {
      // Artifacts missing or malformed for lifecycle check
      return "abort";
    }

    const configAgents = getConfigAgents();

    // 2. Temporal Lifecycle Orchestration
    const temporalPolicy = resolveTemporalLifecyclePolicy(agentId, configAgents);
    const timestamps = getSessionTimestamps(sessionKey);

    if (shouldRotateSessionForTemporalPolicy(temporalPolicy, timestamps)) {
      resetSession(sessionKey, agentId);
      logger.info(
        { traceId: ctx.traceId, sessionKey, agentId, trigger: "temporal_freshness" },
        "Session auto-rotated by temporal policy",
      );
    }

    return "continue";
  } catch {
    // TODO: Connect to centralized error flow
    return "abort";
  }
};
