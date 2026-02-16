import type { CleanupFlow } from "../contract";

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
  const setSessionModel = (sessionKey: string, modelRef: string) =>
    deps.setSessionModel(sessionKey, modelRef);
  const emitPhase = (params: Parameters<typeof deps.emitPhaseSafely>[0]) =>
    deps.emitPhaseSafely(params);
  const stopTypingIndicator = (params: Parameters<typeof deps.stopTypingIndicator>[0]) =>
    deps.stopTypingIndicator(params);
  const { logger } = deps;

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
