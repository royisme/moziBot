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
}

export interface MediaAttachment {
  type: "photo" | "video" | "audio" | "document" | "voice";
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
}

export interface InlineButton {
  text: string;
  callbackData?: string;
  url?: string;
}

export type ChannelStatus = "connected" | "connecting" | "disconnected" | "error";
