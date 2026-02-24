import type { StatusReaction, StatusReactionPayload } from "../../../adapters/channels/types";

export interface ChannelWithStatusReaction {
  readonly setStatusReaction?: (
    peerId: string,
    messageId: string,
    status: StatusReaction,
    payload?: StatusReactionPayload,
  ) => Promise<void>;
}

export interface StatusReactionDeps {
  readonly logger: {
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  readonly toError: (error: unknown) => Error;
}

export async function emitStatusReactionSafely(params: {
  channel: ChannelWithStatusReaction;
  peerId: string;
  messageId: string;
  status: StatusReaction;
  payload?: StatusReactionPayload;
  deps: StatusReactionDeps;
}): Promise<void> {
  const { channel, peerId, messageId, status, payload, deps } = params;

  if (typeof channel.setStatusReaction !== "function") {
    return;
  }

  try {
    await channel.setStatusReaction(peerId, messageId, status, payload);
  } catch (error) {
    deps.logger.warn(
      {
        peerId,
        messageId,
        status,
        error: deps.toError(error).message,
      },
      "Failed to set status reaction",
    );
  }
}
