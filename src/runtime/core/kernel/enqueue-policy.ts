import type { InboundMessage } from "../../adapters/channels/types";
import type { SessionManager } from "../../host/sessions/manager";
import { logger } from "../../../logger";
import { runtimeQueue } from "../../../storage/db";
import { continuationRegistry } from "../continuation";

export function hasActiveSession(params: {
  messageHandler: unknown;
  sessionKey: string;
}): boolean {
  const isSessionActive = (
    params.messageHandler as {
      isSessionActive?: (sessionKey: string) => boolean;
    }
  ).isSessionActive;
  if (typeof isSessionActive !== "function") {
    return false;
  }
  return Boolean(isSessionActive.call(params.messageHandler, params.sessionKey));
}

export async function preemptActiveSessionForLatestInput(params: {
  messageHandler: unknown;
  sessionKey: string;
  messageId: string;
}): Promise<void> {
  const interrupted = runtimeQueue.markInterruptedBySession(
    params.sessionKey,
    "Interrupted by newer inbound message",
  );
  continuationRegistry.cancelSession(params.sessionKey);

  const interruptSession = (
    params.messageHandler as {
      interruptSession?: (sessionKey: string, reason?: string) => Promise<boolean> | boolean;
    }
  ).interruptSession;

  let aborted = false;
  if (typeof interruptSession === "function") {
    aborted = Boolean(
      await Promise.resolve(
        interruptSession.call(
          params.messageHandler,
          params.sessionKey,
          `Interrupted by newer inbound message ${params.messageId}`,
        ),
      ),
    );
  }

  logger.warn(
    {
      sessionKey: params.sessionKey,
      messageId: params.messageId,
      interrupted,
      aborted,
    },
    "Preempted active session run for latest inbound message",
  );
}

export async function tryInjectIntoActiveSession(params: {
  messageHandler: unknown;
  sessionManager: SessionManager;
  resolveSessionContext: (inbound: InboundMessage) => { sessionKey: string; agentId: string };
  extractCommandToken: (text: string) => string;
  isStopCommand: (commandToken: string) => boolean;
  queueItemId: string;
  sessionKey: string;
  inbound: InboundMessage;
  mode: "steer" | "steer-backlog";
}): Promise<boolean> {
  const text = params.inbound.text?.trim() ?? "";
  if (!text) {
    return false;
  }
  if (text.startsWith("/")) {
    const commandToken = params.extractCommandToken(text);
    if (params.isStopCommand(commandToken)) {
      const interrupted = runtimeQueue.markInterruptedBySession(
        params.sessionKey,
        "Interrupted by /stop command",
      );
      continuationRegistry.cancelSession(params.sessionKey);
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
            `Interrupted by stop command ${params.inbound.id}`,
          ),
        );
        if (aborted) {
          logger.warn(
            {
              sessionKey: params.sessionKey,
              messageId: params.inbound.id,
              queueMode: params.mode,
              interrupted,
            },
            "Active session run interrupted by stop command",
          );
        }
      }
    }
    return false;
  }

  if (
    params.mode === "steer-backlog" &&
    hasActiveSession({ messageHandler: params.messageHandler, sessionKey: params.sessionKey })
  ) {
    await preemptActiveSessionForLatestInput({
      messageHandler: params.messageHandler,
      sessionKey: params.sessionKey,
      messageId: params.inbound.id,
    });
    return false;
  }

  const inject = (
    params.messageHandler as {
      steerSession?: (
        sessionKey: string,
        text: string,
        mode: "steer" | "followup",
      ) => Promise<boolean> | boolean;
    }
  ).steerSession;
  if (typeof inject !== "function") {
    return false;
  }

  const injected = await Promise.resolve(
    inject.call(
      params.messageHandler,
      params.sessionKey,
      text,
      params.mode === "steer-backlog" ? "followup" : "steer",
    ),
  );
  if (!injected) {
    return false;
  }

  await params.sessionManager.getOrCreate(params.sessionKey, {
    agentId: params.resolveSessionContext(params.inbound).agentId,
    channel: params.inbound.channel,
    peerId: params.inbound.peerId,
    peerType: params.inbound.peerType === "group" ? "group" : "dm",
    status: "running",
  });
  await params.sessionManager.setStatus(params.sessionKey, "running");
  logger.info(
    {
      queueItemId: params.queueItemId,
      sessionKey: params.sessionKey,
      channel: params.inbound.channel,
      peerId: params.inbound.peerId,
      messageId: params.inbound.id,
      queueMode: params.mode,
    },
    "Inbound message injected into active session run",
  );
  return true;
}
