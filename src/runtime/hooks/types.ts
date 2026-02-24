import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type RuntimeHookName =
  | "before_agent_start"
  | "before_tool_call"
  | "after_tool_call"
  | "before_reset"
  | "turn_completed"
  | "message_received"
  | "message_sending"
  | "message_sent"
  | "llm_input"
  | "llm_output"
  | "before_compaction"
  | "after_compaction"
  | "agent_end";

export type RuntimeObserverHookName =
  | "after_tool_call"
  | "before_reset"
  | "turn_completed"
  | "message_received"
  | "message_sent"
  | "llm_input"
  | "llm_output"
  | "before_compaction"
  | "after_compaction"
  | "agent_end";
export type RuntimeInterceptorHookName =
  | "before_agent_start"
  | "before_tool_call"
  | "message_sending";

export type RuntimeHookBaseContext = {
  sessionKey?: string;
  agentId?: string;
};

export type BeforeAgentStartEvent = {
  promptText: string;
  ingestPlan?: unknown;
};

export type BeforeAgentStartContext = RuntimeHookBaseContext & {
  traceId?: string;
  messageId?: string;
};

export type BeforeAgentStartResult = {
  promptText?: string;
  block?: boolean;
  blockReason?: string;
};

export type BeforeToolCallEvent = {
  toolName: string;
  args: Record<string, unknown>;
};

export type BeforeToolCallContext = RuntimeHookBaseContext;

export type BeforeToolCallResult = {
  args?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
};

export type AfterToolCallEvent = {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
};

export type AfterToolCallContext = RuntimeHookBaseContext;

export type BeforeResetEvent = {
  reason: string;
  messages?: AgentMessage[];
};

export type BeforeResetContext = RuntimeHookBaseContext;

export type TurnCompletedEvent = {
  traceId: string;
  messageId: string;
  status: "success" | "interrupted";
  durationMs: number;
  userText?: string;
  replyText?: string;
};

export type TurnCompletedContext = RuntimeHookBaseContext;

export type MessageReceivedEvent = {
  traceId: string;
  messageId: string;
  text: string;
  normalizedText?: string | null;
  rawStartsWithSlash: boolean;
  isCommand: boolean;
  commandName?: string;
  commandArgs?: string;
  mediaCount: number;
};

export type MessageReceivedContext = RuntimeHookBaseContext & {
  peerId?: string;
  channelId?: string;
  dmScope?: string;
};

export type MessageSentEvent = {
  traceId: string;
  messageId: string;
  replyText?: string;
  content?: string;
  to?: string;
  outboundId?: string | null;
  deliveryMode?: "streaming_finalize" | "streaming_finalize_then_dispatch" | "direct_dispatch";
  channelId?: string;
  peerId?: string;
};

export type MessageSentContext = RuntimeHookBaseContext;

export type MessageSendingEvent = {
  traceId: string;
  messageId: string;
  replyText?: string;
  content?: string;
  to?: string;
  channelId?: string;
  peerId?: string;
};

export type MessageSendingContext = RuntimeHookBaseContext;

export type MessageSendingResult = {
  replyText?: string;
  content?: string;
  cancel?: boolean;
  cancelReason?: string;
};

export type LlmInputEvent = {
  traceId?: string;
  runId: string;
  modelRef: string;
  attempt: number;
  promptText: string;
};

export type LlmInputContext = RuntimeHookBaseContext;

export type LlmOutputEvent = {
  traceId?: string;
  runId: string;
  modelRef: string;
  attempt: number;
  status: "success" | "error";
  durationMs: number;
  outputText?: string;
  error?: string;
};

export type LlmOutputContext = RuntimeHookBaseContext;

export type BeforeCompactionEvent = {
  messageCount: number;
  compactingCount?: number;
  tokenCount?: number;
  messages?: unknown[];
  sessionFile?: string;
};

export type BeforeCompactionContext = RuntimeHookBaseContext;

export type AfterCompactionEvent = {
  messageCount: number;
  tokenCount?: number;
  compactedCount: number;
  sessionFile?: string;
};

export type AfterCompactionContext = RuntimeHookBaseContext;

export type AgentEndEvent = {
  runId: string;
  success: boolean;
  error?: string;
  durationMs?: number;
  messages?: unknown[];
};

export type AgentEndContext = RuntimeHookBaseContext;

export type RuntimeHookHandlerMap = {
  before_agent_start: (
    event: BeforeAgentStartEvent,
    ctx: BeforeAgentStartContext,
  ) => Promise<BeforeAgentStartResult | void> | BeforeAgentStartResult | void;
  before_tool_call: (
    event: BeforeToolCallEvent,
    ctx: BeforeToolCallContext,
  ) => Promise<BeforeToolCallResult | void> | BeforeToolCallResult | void;
  after_tool_call: (event: AfterToolCallEvent, ctx: AfterToolCallContext) => Promise<void> | void;
  before_reset: (event: BeforeResetEvent, ctx: BeforeResetContext) => Promise<void> | void;
  turn_completed: (event: TurnCompletedEvent, ctx: TurnCompletedContext) => Promise<void> | void;
  message_received: (
    event: MessageReceivedEvent,
    ctx: MessageReceivedContext,
  ) => Promise<void> | void;
  message_sending: (
    event: MessageSendingEvent,
    ctx: MessageSendingContext,
  ) => Promise<MessageSendingResult | void> | MessageSendingResult | void;
  message_sent: (event: MessageSentEvent, ctx: MessageSentContext) => Promise<void> | void;
  llm_input: (event: LlmInputEvent, ctx: LlmInputContext) => Promise<void> | void;
  llm_output: (event: LlmOutputEvent, ctx: LlmOutputContext) => Promise<void> | void;
  before_compaction: (
    event: BeforeCompactionEvent,
    ctx: BeforeCompactionContext,
  ) => Promise<void> | void;
  after_compaction: (
    event: AfterCompactionEvent,
    ctx: AfterCompactionContext,
  ) => Promise<void> | void;
  agent_end: (event: AgentEndEvent, ctx: AgentEndContext) => Promise<void> | void;
};

export type RuntimeHookRegistration<K extends RuntimeHookName = RuntimeHookName> = {
  id: string;
  hookName: K;
  handler: RuntimeHookHandlerMap[K];
  priority?: number;
};
