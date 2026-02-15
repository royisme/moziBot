/**
 * Interaction Lifecycle Service
 *
 * Manages side-effects related to the user interaction process,
 * such as typing indicators and phase notifications.
 */

export type InteractionPhase =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "executing"
  | "error";

export interface PhasePayload {
  readonly sessionKey?: string;
  readonly agentId?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly messageId?: string;
}

export interface ChannelWithLifecycle {
  readonly beginTyping?: (peerId: string) => Promise<(() => Promise<void> | void) | undefined>;
  readonly emitPhase?: (
    peerId: string,
    phase: InteractionPhase,
    payload?: PhasePayload,
  ) => Promise<void>;
}

export interface InteractionLifecycleDeps {
  readonly logger: {
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  readonly toError: (error: unknown) => Error;
}

/**
 * Safely emits an interaction phase to the channel if supported.
 */
export async function emitPhaseSafely(params: {
  channel: ChannelWithLifecycle;
  peerId: string;
  phase: InteractionPhase;
  payload?: PhasePayload;
  deps: InteractionLifecycleDeps;
}): Promise<void> {
  const { channel, peerId, phase, payload, deps } = params;

  if (typeof channel.emitPhase !== "function") {
    return;
  }

  try {
    await channel.emitPhase(peerId, phase, payload);
  } catch (error) {
    deps.logger.warn(
      {
        peerId,
        phase,
        error: deps.toError(error).message,
      },
      "Failed to emit channel phase",
    );
  }
}

/**
 * Starts a typing indicator on the channel if supported.
 * Returns a cleanup function to stop the indicator.
 */
export async function startTypingIndicator(params: {
  channel: ChannelWithLifecycle;
  peerId: string;
  sessionKey: string;
  agentId: string;
  deps: InteractionLifecycleDeps;
}): Promise<(() => Promise<void> | void) | undefined> {
  const { channel, peerId, sessionKey, agentId, deps } = params;

  if (typeof channel.beginTyping !== "function") {
    return undefined;
  }

  try {
    const stop = await channel.beginTyping(peerId);
    return stop ?? undefined;
  } catch (error) {
    deps.logger.warn(
      {
        sessionKey,
        agentId,
        peerId,
        error: deps.toError(error).message,
      },
      "Failed to start typing indicator",
    );
    return undefined;
  }
}

/**
 * Stops an active typing indicator using the provided stop function.
 */
export async function stopTypingIndicator(params: {
  stop?: () => Promise<void> | void;
  sessionKey: string;
  agentId: string;
  peerId: string;
  deps: InteractionLifecycleDeps;
}): Promise<void> {
  const { stop, sessionKey, agentId, peerId, deps } = params;

  if (!stop) {
    return;
  }

  try {
    await stop();
  } catch (error) {
    deps.logger.warn(
      {
        sessionKey,
        agentId,
        peerId,
        error: deps.toError(error).message,
      },
      "Failed to stop typing indicator",
    );
  }
}
