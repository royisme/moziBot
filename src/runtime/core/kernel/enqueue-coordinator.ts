import type { InboundMessage } from "../../adapters/channels/types";
import { logger } from "../../../logger";
import { runtimeQueue } from "../../../storage/db";
import { continuationRegistry } from "../continuation";

export async function handleStopCommand(params: {
  messageHandler: unknown;
  sessionKey: string;
  inbound: InboundMessage;
}): Promise<void> {
  const interrupted = runtimeQueue.markInterruptedBySession(
    params.sessionKey,
    "Cancelled by /stop command",
  );
  continuationRegistry.cancelSession(params.sessionKey);
  const interruptSession = (
    params.messageHandler as {
      interruptSession?: (sessionKey: string, reason?: string) => Promise<boolean> | boolean;
    }
  ).interruptSession;
  if (typeof interruptSession === "function") {
    await Promise.resolve(
      interruptSession.call(
        params.messageHandler,
        params.sessionKey,
        `Cancelled by /stop command ${params.inbound.id}`,
      ),
    );
  }
  if (interrupted > 0) {
    logger.warn(
      {
        sessionKey: params.sessionKey,
        interrupted,
        messageId: params.inbound.id,
      },
      "Cancelled queued/running items for session by /stop command",
    );
  }
}

export async function handleInterruptMode(params: {
  messageHandler: unknown;
  sessionKey: string;
  inbound: InboundMessage;
}): Promise<void> {
  const interrupted = runtimeQueue.markInterruptedBySession(
    params.sessionKey,
    "Interrupted by newer inbound message",
  );
  if (interrupted > 0) {
    logger.warn(
      { sessionKey: params.sessionKey, interrupted },
      "Queue items interrupted for latest inbound message",
    );
  }
  const interruptSession = (
    params.messageHandler as {
      interruptSession?: (sessionKey: string, reason?: string) => Promise<boolean> | boolean;
    }
  ).interruptSession;
  if (typeof interruptSession === "function") {
    const aborted = await Promise.resolve(
      interruptSession.call(
        params.messageHandler,
        params.sessionKey,
        `Interrupted by inbound message ${params.inbound.id}`,
      ),
    );
    if (aborted) {
      logger.warn(
        { sessionKey: params.sessionKey, messageId: params.inbound.id },
        "Active session run aborted by interrupt mode",
      );
    }
  }
}
