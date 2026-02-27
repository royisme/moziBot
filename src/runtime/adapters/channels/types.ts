// Normalized message format (platform-agnostic)
export interface InboundMessage {
  id: string;
  channel: string; // "telegram", "discord", etc
  peerId: string; // Chat/channel ID
  peerType: "dm" | "group" | "channel";
  senderId: string;
  senderName?: string;
  text: string;
  media?: MediaAttachment[];
  replyToId?: string;
  accountId?: string;
  threadId?: string | number;
  timestamp: Date;
  raw: unknown; // Original platform message
}

export interface OutboundMessage {
  text?: string;
  media?: MediaAttachment[];
  replyToId?: string;
  buttons?: InlineButton[][];
  silent?: boolean;
  traceId?: string;
}

export interface MediaAttachment {
  type: "photo" | "video" | "audio" | "document" | "voice" | "animation" | "video_note" | "gif";
  url?: string;
  path?: string;
  buffer?: Buffer;
  mimeType?: string;
  filename?: string;
  caption?: string;
  byteSize?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  /** Send audio as voice message instead of audio file */
  asVoice?: boolean;
  /** Send video as video note instead of regular video */
  asVideoNote?: boolean;
}

export interface InlineButton {
  text: string;
  callbackData?: string;
  url?: string;
}

export type ChannelStatus = "connected" | "connecting" | "disconnected" | "error";

export type StatusReaction = "queued" | "thinking" | "tool" | "done" | "error";

export interface StatusReactionPayload {
  readonly sessionKey?: string;
  readonly agentId?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly messageId?: string;
}
