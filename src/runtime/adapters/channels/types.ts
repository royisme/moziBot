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
  poll?: {
    question: string;
    options: string[];
    allowMultiselect?: boolean;
    durationHours?: number;
  };
  webhookUrl?: string;
  silent?: boolean;
  traceId?: string;
  threadId?: string | number;
}

export type ChannelActionName =
  | "send_text"
  | "send_media"
  | "reply"
  | "edit"
  | "delete"
  | "react"
  | "poll";

export interface ChannelTarget {
  peerId?: string;
  threadId?: string;
  replyToId?: string;
  messageId?: string;
}

export interface ChannelCapabilities {
  media: boolean;
  polls: boolean;
  reactions: boolean;
  threads: boolean;
  editMessage: boolean;
  deleteMessage: boolean;
  implicitCurrentTarget: boolean;
  maxTextLength?: number;
  maxCaptionLength?: number;
  supportedActions: ChannelActionName[];
}

export interface ChannelActionSpec {
  name: ChannelActionName;
  enabled: boolean;
  description?: string;
}

export interface ChannelActionQueryContext {
  peerType?: "dm" | "group" | "channel";
  threadId?: string;
  accountId?: string;
}

interface BaseChannelAction {
  type: ChannelActionName;
  target?: ChannelTarget;
}

export interface SendTextChannelAction extends BaseChannelAction {
  type: "send_text" | "reply";
  text: string;
  silent?: boolean;
  buttons?: InlineButton[][];
}

export interface SendMediaChannelAction extends BaseChannelAction {
  type: "send_media";
  media: MediaAttachment[];
  text?: string;
  silent?: boolean;
  buttons?: InlineButton[][];
}

export interface PollChannelAction extends BaseChannelAction {
  type: "poll";
  question: string;
  options: string[];
  allowMultiselect?: boolean;
  durationHours?: number;
}

export interface EditChannelAction extends BaseChannelAction {
  type: "edit";
  messageId: string;
  text: string;
}

export interface DeleteChannelAction extends BaseChannelAction {
  type: "delete";
  messageId: string;
}

export interface ReactChannelAction extends BaseChannelAction {
  type: "react";
  messageId: string;
  emoji: string;
}

export type ChannelAction =
  | SendTextChannelAction
  | SendMediaChannelAction
  | PollChannelAction
  | EditChannelAction
  | DeleteChannelAction
  | ReactChannelAction;

export interface ChannelActionEnvelope {
  actions: ChannelAction[];
  fallbackText?: string;
}

export interface CurrentChannelTarget {
  peerId: string;
  threadId?: string;
  replyToId?: string;
}

export interface CurrentChannelContext {
  channelId: string;
  peerId: string;
  peerType: "dm" | "group" | "channel";
  accountId?: string;
  threadId?: string;
  replyToId?: string;
  sessionKey?: string;
  capabilities: ChannelCapabilities;
  allowedActions: ChannelActionName[];
  defaultTarget: CurrentChannelTarget;
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

export type StatusReaction = "queued" | "thinking" | "tool" | "done" | "degraded" | "error";

export interface StatusReactionPayload {
  readonly sessionKey?: string;
  readonly agentId?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly messageId?: string;
}
