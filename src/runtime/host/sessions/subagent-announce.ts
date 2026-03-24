import { logger } from "../../../logger";
import type { MessageHandler } from "../message-handler";
import { deliverGuaranteedLifecycleNotification } from "./async-task-delivery";
import type { DetachedRunStatus } from "./subagent-registry";

export type DetachedRunAnnouncementStatus =
  | DetachedRunStatus
  | "accepted"
  | "started"
  | "streaming";

export interface DetachedRunAnnouncementParams {
  runId: string;
  childKey: string;
  parentKey: string;
  task: string;
  label?: string;
  kind?: "subagent" | "acp";
  status: DetachedRunAnnouncementStatus;
  result?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

function formatDuration(startMs?: number, endMs?: number): string {
  if (!startMs || !endMs) {
    return "n/a";
  }
  const totalSec = Math.round((endMs - startMs) / 1000);
  if (totalSec < 60) {
    return `${totalSec}s`;
  }
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m${sec}s`;
}

function buildStatusLabel(status: DetachedRunAnnouncementStatus, error?: string): string {
  switch (status) {
    case "accepted":
      return "has been accepted";
    case "started":
      return "has started";
    case "streaming":
      return "is producing output";
    case "completed":
      return "completed successfully";
    case "failed":
      return `failed: ${error || "unknown error"}`;
    case "timeout":
      return "timed out";
    case "aborted":
      return error ? `was cancelled: ${error}` : "was cancelled";
    default:
      return "finished with unknown status";
  }
}

export function buildDetachedRunTriggerMessage(params: DetachedRunAnnouncementParams): string {
  const taskLabel = params.label || params.task || "background task";
  const statusLabel = buildStatusLabel(params.status, params.error);
  const duration = formatDuration(params.startedAt, params.endedAt);

  // Short, natural messages for non-terminal phases
  const isTerminal = ["completed", "failed", "timeout", "aborted"].includes(params.status);

  if (!isTerminal) {
    // Non-terminal: short, user-friendly
    let message = "";
    switch (params.status) {
      case "accepted":
        message = `Background task "${taskLabel}" has been queued.`;
        break;
      case "started":
        message = `Working on "${taskLabel}"...`;
        break;
      case "streaming":
        message = `Task "${taskLabel}" is producing output.`;
        break;
      default:
        message = `Task "${taskLabel}" status: ${params.status}`;
    }
    return [message, "", "Acknowledge this briefly. You can respond with NO_REPLY."].join("\n");
  }

  // Terminal phases: brief message only — details available via /tasks status <runId>
  return [
    `Background task "${taskLabel}" ${statusLabel}. Duration: ${duration}.`,
    "",
    "Acknowledge this briefly. You can respond with NO_REPLY.",
  ].join("\n");
}

let messageHandlerRef: MessageHandler | null = null;

export function injectMessageHandler(handler: MessageHandler): void {
  messageHandlerRef = handler;
}

export async function announceDetachedRun(params: DetachedRunAnnouncementParams): Promise<boolean> {
  if (!messageHandlerRef) {
    logger.warn("MessageHandler not injected, skipping announce");
    return false;
  }

  // Build the fallback (summarization) function
  const fallbackAnnounce = async (): Promise<boolean> => {
    const triggerMessage = buildDetachedRunTriggerMessage(params);
    try {
      await messageHandlerRef!.handleInternalMessage({
        sessionKey: params.parentKey,
        content: triggerMessage,
        source: "detached-run-announce",
        metadata: {
          taskKind: params.kind ?? "subagent",
          detachedRunId: params.runId,
          detachedChildKey: params.childKey,
          detachedStatus: params.status,
        },
      });
      return true;
    } catch (err) {
      logger.error({ err, runId: params.runId }, "Fallback announce failed");
      return false;
    }
  };

  // Use guaranteed delivery path - direct delivery first, then fallback
  const taskLabel = params.label || params.task || "background task";
  const result = await deliverGuaranteedLifecycleNotification({
    sessionKey: params.parentKey,
    taskLabel,
    phase: params.status,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    error: params.error,
    fallbackAnnounce,
  });

  // Log delivery outcome for debugging/evidence
  if (result.delivered) {
    if (result.usedFallback) {
      logger.info(
        { runId: params.runId, status: params.status },
        "Lifecycle notification delivered via fallback (summarization)",
      );
    } else {
      logger.info(
        { runId: params.runId, status: params.status, messageId: result.messageId },
        "Lifecycle notification delivered directly to user",
      );
    }
  } else {
    logger.warn(
      { runId: params.runId, status: params.status },
      "Lifecycle notification delivery failed - no message sent",
    );
  }

  return result.delivered;
}

// Keep backwards compatibility alias
export const announceDetachedRunResult = announceDetachedRun;
