export const SessionStatus = {
  QUEUED: "queued",
  RUNNING: "running",
  RETRYING: "retrying",
  COMPLETED: "completed",
  FAILED: "failed",
  INTERRUPTED: "interrupted",
} as const;

export type SessionStatusValue = (typeof SessionStatus)[keyof typeof SessionStatus];

export const QueueMode = {
  FOLLOWUP: "followup",
  COLLECT: "collect",
  INTERRUPT: "interrupt",
  STEER: "steer",
  STEER_BACKLOG: "steer-backlog",
} as const;

export type QueueModeValue = (typeof QueueMode)[keyof typeof QueueMode];

export const PeerType = {
  DM: "dm",
  GROUP: "group",
  CHANNEL: "channel",
} as const;

export type PeerTypeValue = (typeof PeerType)[keyof typeof PeerType];

export const MessageRole = {
  USER: "user",
  ASSISTANT: "assistant",
  TOOL_RESULT: "toolResult",
  SYSTEM: "system",
} as const;

export type MessageRoleValue = (typeof MessageRole)[keyof typeof MessageRole];

export const ChannelId = {
  TELEGRAM: "telegram",
  DISCORD: "discord",
  LOCAL_DESKTOP: "local-desktop",
} as const;

export type ChannelIdValue = (typeof ChannelId)[keyof typeof ChannelId];

export const CommandToken = {
  STOP: "/stop",
} as const;

export type CommandTokenValue = (typeof CommandToken)[keyof typeof CommandToken];
