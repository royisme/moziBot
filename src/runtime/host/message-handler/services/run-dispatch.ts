import type { ChannelPlugin } from "../../../adapters/channels/plugin";
import type { InboundMessage } from "../../../adapters/channels/types";

export type DetachedRunStarter = (params: {
  message: InboundMessage;
  channel: ChannelPlugin;
  queueItemId?: string;
  onTerminal?: (params: {
    terminal: "completed" | "failed" | "aborted";
    error?: Error;
    reason?: string;
    errorCode?: string;
  }) => Promise<void> | void;
}) => Promise<{ runId: string }>;

export async function startDetachedRun(params: {
  starter: DetachedRunStarter;
  message: InboundMessage;
  channel: ChannelPlugin;
  queueItemId?: string;
  onTerminal?: (params: {
    terminal: "completed" | "failed" | "aborted";
    error?: Error;
    reason?: string;
    errorCode?: string;
  }) => Promise<void> | void;
}): Promise<{ runId: string }> {
  return await params.starter({
    message: params.message,
    channel: params.channel,
    queueItemId: params.queueItemId,
    onTerminal: params.onTerminal,
  });
}
