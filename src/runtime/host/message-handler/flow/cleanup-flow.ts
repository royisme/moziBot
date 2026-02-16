import type { CleanupFlow } from "../contract";
import type { InteractionPhase, PhasePayload } from "../services/interaction-lifecycle";

/**
 * Runtime-guarded helper to ensure a function exists on an unknown object.
 */
function requireFn<T>(deps: unknown, key: string): T {
  const obj = deps as Record<string, unknown>;
  const fn = obj[key];
  if (typeof fn !== "function") {
    throw new Error(`Missing required dependency function: ${key}`);
  }
  return fn as unknown as T;
}

function requireObj<T extends object>(deps: unknown, key: string): T {
  const obj = deps as Record<string, unknown>;
  const target = obj[key];
  if (!target || typeof target !== "object") {
    throw new Error(`Missing required dependency object: ${key}`);
  }
  return target as T;
}

/**
 * Cleanup Flow Implementation
 *
 * Orchestrates the finally-path cleanup logic:
 * - Restores model overrides switched for capability reasons
 * - Emits the "idle" interaction phase
 * - Shuts down the typing indicator
 * - Clears transient execution artifacts from state
 *
 * Resilient design: Each step is independently guarded.
 */
export const runCleanupFlow: CleanupFlow = async (ctx, deps, _bundle) => {
  const { state } = ctx;

  // Artifact Extraction
  const sessionKey = typeof state.sessionKey === "string" ? state.sessionKey : undefined;
  const agentId = typeof state.agentId === "string" ? state.agentId : undefined;
  const peerId = typeof state.peerId === "string" ? state.peerId : undefined;
  const restoreModelRef =
    typeof state.capabilityRestoreModelRef === "string"
      ? state.capabilityRestoreModelRef
      : undefined;
  const stopTyping =
    typeof state.stopTyping === "function"
      ? (state.stopTyping as () => Promise<void> | void)
      : undefined;

  // Dependency Extraction
  const setSessionModel = requireFn<(sk: string, m: string) => Promise<void>>(
    deps,
    "setSessionModel",
  );
  const emitPhase = requireFn<
    (p: { phase: InteractionPhase; payload: PhasePayload }) => Promise<void>
  >(deps, "emitPhaseSafely");
  const stopTypingIndicator = requireFn<
    (p: {
      stop?: () => Promise<void> | void;
      sessionKey: string;
      agentId: string;
      peerId: string;
    }) => Promise<void>
  >(deps, "stopTypingIndicator");
  const logger = requireObj<{ warn: (o: Record<string, unknown>, m: string) => void }>(
    deps,
    "logger",
  );

  // 1. Model Restoration
  if (sessionKey && restoreModelRef) {
    try {
      await setSessionModel(sessionKey, restoreModelRef);
    } catch (error) {
      logger.warn(
        { traceId: ctx.traceId, sessionKey, agentId, restoreModelRef, error: String(error) },
        "Failed to restore pre-routing session model",
      );
    }
  }

  // 2. Interaction Signaling
  if (sessionKey && agentId && peerId) {
    try {
      await emitPhase({
        phase: "idle",
        payload: { sessionKey, agentId, messageId: ctx.messageId },
      });
    } catch {
      // Internal emit failure usually logged by service, but flow-level guard preserved
    }
  }

  // 3. Typing Cleanup
  if (sessionKey && agentId && peerId) {
    try {
      await stopTypingIndicator({
        stop: stopTyping,
        sessionKey,
        agentId,
        peerId,
      });
    } catch {
      // Stop failure usually logged by service
    }
  }

  // 4. Artifact Cleanup (Optional transient clearing)
  // Ensures state isn't polluted for subsequent (theoretical) re-runs or middleware
  delete state.stopTyping;
  delete state.capabilityRestoreModelRef;
  delete state.streamingBuffer;
};
