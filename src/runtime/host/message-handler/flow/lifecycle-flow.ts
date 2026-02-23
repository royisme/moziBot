import type { LifecycleFlow } from "../contract";
import {
  resolveTemporalLifecyclePolicy,
  shouldRotateSessionForTemporalPolicy,
} from "../lifecycle/temporal";
import type { InboundMessage } from "../../../adapters/channels/types";
import {
  resolveSessionResetPolicy,
  resolveSessionType,
  shouldRotateSessionForResetPolicy,
} from "../lifecycle/reset-policy";

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
    const inbound = ctx.payload as InboundMessage | undefined;
    const channelId = inbound && typeof inbound.channel === "string" ? inbound.channel : undefined;
    const sessionType = resolveSessionType({
      peerType: inbound?.peerType,
      threadId: inbound?.threadId,
    });

    // 2. Temporal or Session Reset Policy Orchestration
    const timestamps = getSessionTimestamps(sessionKey);
    const resetPolicy = resolveSessionResetPolicy({
      config: deps.config,
      sessionType,
      channelId,
    });

    if (resetPolicy) {
      if (shouldRotateSessionForResetPolicy(resetPolicy, timestamps)) {
        resetSession(sessionKey, agentId);
        logger.info(
          {
            traceId: ctx.traceId,
            sessionKey,
            agentId,
            trigger: "session_reset_policy",
            mode: resetPolicy.mode,
            channelId,
            sessionType,
          },
          "Session auto-rotated by session reset policy",
        );
      }
      return "continue";
    }

    const temporalPolicy = resolveTemporalLifecyclePolicy(agentId, configAgents);

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
