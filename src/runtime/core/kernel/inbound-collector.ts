import type { InboundMessage } from "../../adapters/channels/types";
import type { SessionManager } from "../../host/sessions/manager";
import type { RuntimeEnqueueResult, RuntimeInboundEnvelope, RuntimeQueueMode } from "../contracts";
import { logger } from "../../../logger";
import { runtimeQueue } from "../../../storage/db";
import { CommandToken, PeerType, SessionStatus } from "../constants";

export function extractCommandToken(text: string): string {
  if (!text.startsWith("/")) {
    return "";
  }
  return text.split(/\s+/, 1)[0]?.split("@", 1)[0]?.toLowerCase() ?? "";
}

export function isStopCommand(commandToken: string): boolean {
  return commandToken === CommandToken.STOP;
}

export function parseInbound(json: string): InboundMessage {
  const parsed = JSON.parse(json) as InboundMessage & { timestamp: string | Date };
  const timestamp =
    parsed.timestamp instanceof Date ? parsed.timestamp : new Date(parsed.timestamp || Date.now());
  return {
    ...parsed,
    timestamp,
    peerType: parsed.peerType || PeerType.DM,
  };
}

export function mergeInbound(
  previous: InboundMessage,
  incoming: InboundMessage,
  receivedAt: Date,
): InboundMessage {
  const chunks = [previous.text?.trim(), incoming.text?.trim()].filter((value): value is string =>
    Boolean(value),
  );
  const mergedText = chunks.join("\n");
  return {
    ...incoming,
    text: mergedText || incoming.text || previous.text,
    media: incoming.media?.length ? incoming.media : previous.media,
    timestamp: receivedAt,
  };
}

export async function tryCollectIntoQueued(params: {
  envelope: RuntimeInboundEnvelope;
  sessionKey: string;
  queueMode: RuntimeQueueMode;
  collectWindowMs: number;
  sessionManager: SessionManager;
  trimSessionBacklog: (sessionKey: string) => void;
}): Promise<RuntimeEnqueueResult | null> {
  const { envelope, sessionKey, queueMode, collectWindowMs, sessionManager, trimSessionBacklog } =
    params;
  if (collectWindowMs <= 0) {
    return null;
  }
  const since = new Date(envelope.receivedAt.getTime() - collectWindowMs).toISOString();
  const latest = runtimeQueue.findLatestQueuedBySessionSince(sessionKey, since);
  if (!latest) {
    return null;
  }

  const previous = parseInbound(latest.inbound_json);
  const merged = mergeInbound(previous, envelope.inbound, envelope.receivedAt);
  const availableAt = new Date(envelope.receivedAt.getTime() + collectWindowMs).toISOString();
  const updated = runtimeQueue.mergeQueuedInbound(latest.id, JSON.stringify(merged), availableAt);
  if (!updated) {
    return null;
  }

  await sessionManager.setStatus(sessionKey, SessionStatus.QUEUED);
  trimSessionBacklog(sessionKey);
  logger.info(
    {
      sessionKey,
      queueItemId: latest.id,
      queueMode,
      collectWindowMs,
      mergedMessageId: envelope.inbound.id,
      mergedTextLength: merged.text.length,
    },
    "Inbound message collected into queued envelope",
  );
  return {
    accepted: true,
    deduplicated: false,
    queueItemId: latest.id,
    sessionKey,
  };
}
