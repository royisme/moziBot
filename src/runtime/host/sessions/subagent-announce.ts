import type { MessageHandler } from "../message-handler";
import { logger } from "../../../logger";

export interface AnnounceParams {
  runId: string;
  childKey: string;
  parentKey: string;
  task: string;
  label?: string;
  status: "completed" | "failed" | "timeout";
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

function buildStatusLabel(status: string, error?: string): string {
  switch (status) {
    case "completed":
      return "completed successfully";
    case "failed":
      return `failed: ${error || "unknown error"}`;
    case "timeout":
      return "timed out";
    default:
      return "finished with unknown status";
  }
}

export function buildTriggerMessage(params: AnnounceParams): string {
  const taskLabel = params.label || params.task || "background task";
  const statusLabel = buildStatusLabel(params.status, params.error);
  const duration = formatDuration(params.startedAt, params.endedAt);

  const lines = [
    `A background task "${taskLabel}" just ${statusLabel}.`,
    "",
    "Findings:",
    params.result || "(no output)",
    "",
    `Stats: runtime ${duration} • sessionKey ${params.childKey}`,
    "",
    "Summarize this naturally for the user. Keep it brief (1-2 sentences).",
    "Flow it into the conversation naturally.",
    "Do not mention technical details like sessionKey or that this was a background task.",
    "You can respond with NO_REPLY if no announcement is needed.",
  ];

  return lines.join("\n");
}

let messageHandlerRef: MessageHandler | null = null;

export function injectMessageHandler(handler: MessageHandler): void {
  messageHandlerRef = handler;
}

export async function announceSubagentResult(params: AnnounceParams): Promise<boolean> {
  if (!messageHandlerRef) {
    logger.warn("MessageHandler not injected, skipping announce");
    return false;
  }

  const triggerMessage = buildTriggerMessage(params);

  logger.info(
    {
      runId: params.runId,
      parentKey: params.parentKey,
      status: params.status,
    },
    "Announcing subagent result to parent",
  );

  try {
    await messageHandlerRef.handleInternalMessage({
      sessionKey: params.parentKey,
      content: triggerMessage,
      source: "subagent-announce",
      metadata: {
        subagentRunId: params.runId,
        subagentChildKey: params.childKey,
        subagentStatus: params.status,
      },
    });

    return true;
  } catch (err) {
    logger.error({ err, runId: params.runId }, "Failed to announce subagent result");
    return false;
  }
}
