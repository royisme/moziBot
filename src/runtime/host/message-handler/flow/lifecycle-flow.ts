import type { LifecycleFlow } from "../contract";
import {
  resolveTemporalLifecyclePolicy,
  shouldRotateSessionForTemporalPolicy,
  type SessionTimestamps,
} from "../lifecycle/temporal";
import {
  evaluateSemanticLifecycle,
  resolveSemanticLifecyclePolicy,
  type SemanticSessionMetadata,
} from "../lifecycle/semantic";

/**
 * Runtime-guarded helper to ensure a function exists on an unknown object.
 */
type UnknownRecord = Record<string, unknown>;

function requireFn<T>(deps: unknown, key: string): T {
  if (!deps || typeof deps !== "object") {
    throw new Error(`Missing dependency container for function: ${key}`);
  }
  const obj = deps as UnknownRecord;
  const fn = obj[key];
  if (typeof fn !== "function") {
    throw new Error(`Missing required dependency function: ${key}`);
  }
  return fn as T;
}

function requireObj<T extends object>(deps: unknown, key: string): T {
  if (!deps || typeof deps !== "object") {
    throw new Error(`Missing dependency container for object: ${key}`);
  }
  const value = (deps as UnknownRecord)[key];
  if (!value || typeof value !== "object") {
    throw new Error(`Missing required dependency object: ${key}`);
  }
  return value as T;
}

/**
 * Lifecycle Flow Implementation
 * 
 * Orchestrates temporal and semantic session lifecycle checks and transitions.
 * Preserves monolith parity by skipping for commands and following exact update order.
 */
export const runLifecycleFlow: LifecycleFlow = async (ctx, deps) => {
  const { state } = ctx;

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

    // Dependency extraction
    const resetSession = requireFn<(sk: string, ai: string) => void>(deps, "resetSession");
    const getSessionTimestamps = requireFn<(sk: string) => SessionTimestamps>(deps, "getSessionTimestamps");
    const getSessionMetadata = requireFn<(sk: string) => Record<string, unknown>>(deps, "getSessionMetadata");
    const updateMetadata = requireFn<(sk: string, meta: Record<string, unknown>) => void>(
      deps,
      "updateSessionMetadata",
    );
    const revertToPreviousSegment = requireFn<(sk: string, ai: string) => boolean>(
      deps,
      "revertToPreviousSegment",
    );
    const getConfigAgents = requireFn<() => Record<string, unknown>>(deps, "getConfigAgents");
    const logger = requireObj<{ info: (o: Record<string, unknown>, m: string) => void }>(deps, "logger");
    const getSessionMessages = requireFn<(sk: string) => unknown[]>(deps, "getSessionMessages");

    const configAgents = getConfigAgents();

    // 2. Temporal Lifecycle Orchestration
    const temporalPolicy = resolveTemporalLifecyclePolicy(agentId, configAgents);
    const timestamps = getSessionTimestamps(sessionKey);
    
    if (shouldRotateSessionForTemporalPolicy(temporalPolicy, timestamps)) {
      resetSession(sessionKey, agentId);
      logger.info(
        { sessionKey, agentId, trigger: "temporal_freshness" },
        "Session auto-rotated by temporal policy",
      );
    }

    // 3. Semantic Lifecycle Orchestration
    const semanticPolicy = resolveSemanticLifecyclePolicy(agentId, configAgents);
    const rawMetadata = getSessionMetadata(sessionKey);
    const semanticMetadata =
      (rawMetadata.lifecycle as { semantic?: SemanticSessionMetadata } | undefined)?.semantic ?? {};
    
    // TODO: Injected history fetcher for semantic comparison
    const previousMessages = getSessionMessages(sessionKey);

    const semanticResult = evaluateSemanticLifecycle({
      policy: semanticPolicy,
      currentText: text,
      previousMessages,
      metadata: semanticMetadata,
    });

    if (semanticResult.shouldRevert) {
      const success = revertToPreviousSegment(sessionKey, agentId);
      if (success) {
        // Monolith logic: update metadata with revert trace
        updateMetadata(sessionKey, {
          lifecycle: {
            semantic: {
              lastRotationAt: Date.now(),
               lastRotationType: "semantic_revert",
               lastConfidence: semanticResult.confidence,
            },
          },
        });
        logger.info(
          { sessionKey, agentId, trigger: "semantic_revert" },
          "Session semantic misfire reverted",
        );
      }
    } else if (semanticResult.shouldRotate) {
      resetSession(sessionKey, agentId);
      updateMetadata(sessionKey, {
        lifecycle: {
          semantic: {
            lastRotationAt: Date.now(),
               lastRotationType: "semantic",
               lastConfidence: semanticResult.confidence,
            // TODO: Capture controlModelRef if returned by evaluator
          },
        },
      });
      logger.info(
        { sessionKey, agentId, trigger: "semantic_shift" },
        "Session auto-rotated by semantic policy",
      );
    }

    return "continue";
  } catch {
    // TODO: Connect to centralized error flow
    return "abort";
  }
};
