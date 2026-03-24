import { logger } from "../../../logger";
import { runtimeQueue } from "../../../storage/db";
import type { ChannelRegistry } from "../../adapters/channels/registry";
import type { InboundMessage } from "../../adapters/channels/types";
import { continuationRegistry } from "../continuation";

export async function handleStopCommand(params: {
  messageHandler: unknown;
  sessionKey: string;
  inbound: InboundMessage;
  channelRegistry?: ChannelRegistry;
  activeSessions?: Set<string>;
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
  if (params.channelRegistry) {
    const channel = params.channelRegistry.get(params.inbound.channel);
    if (channel) {
      const hasActiveRun = params.activeSessions?.has(params.sessionKey) ?? false;
      const text =
        interrupted > 0
          ? `Stopped. (cancelled ${interrupted} queued item${interrupted > 1 ? "s" : ""})`
          : hasActiveRun
            ? "Stop signal sent."
            : "No active run to stop.";
      await channel
        .send(params.inbound.peerId, { text })
        .catch((err: unknown) => logger.warn({ err }, "Failed to send /stop confirmation"));
    }
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
